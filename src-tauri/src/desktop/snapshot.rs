//! A window's tree, as text the model can read and refs it can act on.
//!
//! The raw tree an OS hands back is mostly scaffolding: unlabeled groups inside
//! unlabeled groups, zero-size spacers, text that repeats its button's title,
//! whole scroll views of content nobody can see. Printed as-is, Mail's inbox is
//! thousands of lines. So this prunes hard, caps what is left, and says exactly
//! where it stopped so the model can ask for that part.

use super::safety;
use super::{AppId, RawElement, Rect, Role, WindowKey};

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub index: usize,
    pub role: Role,
    pub label: String,
}

/// What a ref remembers: enough to act on it now, and enough to find it again
/// by role, label and path when it is from an older snapshot.
#[derive(Debug, Clone)]
pub struct RefEntry<H> {
    pub number: u32,
    pub snapshot: u32,
    pub app: AppId,
    pub window: WindowKey,
    pub handle: H,
    pub role: Role,
    pub label: String,
    pub path: Vec<Step>,
    pub frame: Option<Rect>,
    pub secure: bool,
    pub irreversible: bool,
}

/// What the engine keeps about a window's latest snapshot, for the checks that
/// act on a window rather than on a ref.
#[derive(Debug, Clone, Default)]
pub struct WindowSeen {
    pub snapshot: u32,
    pub focused_role: Option<Role>,
    pub focused_secure: bool,
    pub irreversible_any: bool,
    /// Where the irreversible things are, so a coordinate click on one is
    /// gated like a ref press.
    pub danger: Vec<(Rect, String)>,
}

pub struct NewRef<H> {
    pub number: u32,
    pub entry: RefEntry<H>,
}

pub struct Rendered<H> {
    pub text: String,
    pub refs: Vec<NewRef<H>>,
    pub seen: WindowSeen,
}

#[derive(Debug, Clone, Copy)]
pub struct Caps {
    pub max_depth: usize,
    pub max_nodes: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self { max_depth: 14, max_nodes: 400 }
    }
}

pub fn role_word(role: &Role) -> &str {
    match role {
        Role::Button => "button",
        Role::TextField => "text field",
        Role::TextArea => "text area",
        Role::Checkbox => "checkbox",
        Role::Radio => "radio button",
        Role::MenuItem => "menu item",
        Role::MenuButton => "menu button",
        Role::Link => "link",
        Role::Text => "text",
        Role::Image => "image",
        Role::Group => "group",
        Role::List => "list",
        Role::Row => "row",
        Role::Cell => "cell",
        Role::Tab => "tab",
        Role::Toolbar => "toolbar",
        Role::Slider => "slider",
        Role::Other(s) => s,
    }
}

pub fn describe(role: &Role, label: &str) -> String {
    if label.is_empty() {
        role_word(role).to_string()
    } else {
        format!("{} \"{}\"", role_word(role), clip(label, 60))
    }
}

pub fn ref_name<H>(e: &RefEntry<H>) -> String {
    format!("e{}", e.number)
}

pub fn parse_ref(s: &str) -> Option<u32> {
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    s.strip_prefix('e').unwrap_or(s).parse().ok()
}

pub fn clip(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>())
    }
}

fn count<H>(node: &RawElement<H>) -> usize {
    1 + node.children.iter().map(count).sum::<usize>()
}

fn is_scaffolding(role: &Role) -> bool {
    matches!(role, Role::Group | Role::Other(_) | Role::Image)
}

struct Ctx<'a, H> {
    caps: Caps,
    window: Option<&'a Rect>,
    next_ref: &'a mut u32,
    lines: Vec<String>,
    refs: Vec<NewRef<H>>,
    printed: usize,
    /// Nodes left out for depth or count, by the ref they sit under.
    omitted: Vec<(Option<u32>, usize)>,
    /// Refs under which the OS walk itself stopped.
    walk_stopped: Vec<Option<u32>>,
    stopped: bool,
    seen: WindowSeen,
}

impl<H: Clone> Ctx<'_, H> {
    fn omit(&mut self, under: Option<u32>, n: usize) {
        match self.omitted.iter_mut().find(|(r, _)| *r == under) {
            Some((_, c)) => *c += n,
            None => self.omitted.push((under, n)),
        }
    }

    fn visit(&mut self, node: &RawElement<H>, path: &mut Vec<Step>, depth: usize, parent: Option<(u32, &str)>) {
        if node.offscreen == Some(true) {
            return;
        }
        // Scrolled out of the window: a whole branch nobody can see.
        if let (Some(f), Some(w)) = (node.frame, self.window) {
            if f.w >= 1.0 && f.h >= 1.0 && !f.intersects(w) {
                return;
            }
        }
        let zero = node.frame.is_some_and(|f| f.w < 1.0 || f.h < 1.0);
        if zero && node.children.is_empty() {
            return;
        }
        let label = node.label.trim();
        let value = node.value.as_deref().map(str::trim).filter(|v| !v.is_empty());

        if node.role == Role::Text && label.is_empty() && value.is_none() {
            return;
        }
        // The text inside a button that says what the button already said.
        if node.role == Role::Text && value.is_none() && parent.is_some_and(|(_, l)| l == label) {
            return;
        }
        let unlabeled = label.is_empty() && value.is_none();
        if unlabeled && is_scaffolding(&node.role) && node.children.is_empty() {
            return;
        }
        if zero || (unlabeled && is_scaffolding(&node.role)) {
            // Collapse: its children stand in its place, at its depth.
            self.children(node, path, depth, parent);
            if node.children_truncated {
                self.walk_stopped.push(parent.map(|(n, _)| n));
            }
            return;
        }

        if depth >= self.caps.max_depth || self.printed >= self.caps.max_nodes {
            if self.printed >= self.caps.max_nodes {
                self.stopped = true;
            }
            self.omit(parent.map(|(n, _)| n), count(node));
            return;
        }

        let number = *self.next_ref;
        *self.next_ref += 1;
        self.printed += 1;
        let irreversible = safety::irreversible(&node.role, label);
        self.lines.push(line(number, node, label, value, depth, irreversible));
        if irreversible {
            self.seen.irreversible_any = true;
            if let Some(f) = node.frame {
                self.seen.danger.push((f, describe(&node.role, label)));
            }
        }
        self.refs.push(NewRef {
            number,
            entry: RefEntry {
                number,
                snapshot: 0,
                app: AppId(String::new()),
                window: WindowKey(String::new()),
                handle: node.handle.clone(),
                role: node.role.clone(),
                label: label.to_string(),
                path: path.clone(),
                frame: node.frame,
                secure: node.secure,
                irreversible,
            },
        });

        self.children(node, path, depth + 1, Some((number, label)));
        if node.children_truncated {
            self.walk_stopped.push(Some(number));
        }
    }

    fn children(&mut self, node: &RawElement<H>, path: &mut Vec<Step>, depth: usize, parent: Option<(u32, &str)>) {
        for (i, child) in node.children.iter().enumerate() {
            path.push(Step { index: i, role: child.role.clone(), label: child.label.trim().to_string() });
            self.visit(child, path, depth, parent);
            path.pop();
        }
    }
}

fn line<H>(n: u32, node: &RawElement<H>, label: &str, value: Option<&str>, depth: usize, irreversible: bool) -> String {
    let mut s = format!("{}[e{n}] {}", "  ".repeat(depth), role_word(&node.role));
    if !label.is_empty() {
        s.push_str(&format!(" \"{}\"", clip(label, 80)));
    }
    if node.secure {
        s.push_str(" (password: not readable, not typable)");
    } else if let Some(v) = value.filter(|v| *v != label) {
        s.push_str(&format!(" = \"{}\"", clip(v, 80)));
    }
    if !node.enabled {
        s.push_str(" (disabled)");
    }
    if node.focused {
        s.push_str(" (focused)");
    }
    if irreversible {
        s.push_str(" ⚠ irreversible");
    }
    s
}

/// The deepest focused element, wherever the pruning put it.
fn focused<H>(node: &RawElement<H>) -> Option<&RawElement<H>> {
    node.children.iter().find_map(focused).or(node.focused.then_some(node))
}

/// Follow `path` down from `tree`, checking role and label at every step.
fn follow<'t, H>(tree: &'t RawElement<H>, path: &[Step]) -> Option<&'t RawElement<H>> {
    let mut node = tree;
    for step in path {
        let child = node.children.get(step.index)?;
        if child.role != step.role || child.label.trim() != step.label {
            return None;
        }
        node = child;
    }
    Some(node)
}

fn collect<'t, H>(node: &'t RawElement<H>, role: &Role, label: &str, out: &mut Vec<&'t RawElement<H>>) {
    if &node.role == role && node.label.trim() == label {
        out.push(node);
    }
    for c in &node.children {
        collect(c, role, label, out);
    }
}

/// Find an element again in a fresh walk: by its path if that still holds,
/// otherwise by role and label if exactly one element has them. Anything
/// ambiguous is `None` — acting on the wrong "Delete" is worse than asking for
/// a new snapshot.
pub fn find<'t, H>(tree: &'t RawElement<H>, path: &[Step], role: &Role, label: &str) -> Option<&'t RawElement<H>> {
    if let Some(n) = follow(tree, path) {
        return Some(n);
    }
    if label.is_empty() {
        return None;
    }
    let mut hits = Vec::new();
    collect(tree, role, label, &mut hits);
    (hits.len() == 1).then(|| hits[0])
}

pub fn render<H: Clone>(
    tree: &RawElement<H>,
    window: Option<&Rect>,
    root: Option<&[Step]>,
    next_ref: &mut u32,
    caps: Caps,
) -> Rendered<H> {
    let mut seen = WindowSeen::default();
    if let Some(f) = focused(tree) {
        seen.focused_role = Some(f.role.clone());
        seen.focused_secure = f.secure;
    }
    let mut ctx = Ctx {
        caps,
        window,
        next_ref,
        lines: Vec::new(),
        refs: Vec::new(),
        printed: 0,
        omitted: Vec::new(),
        walk_stopped: Vec::new(),
        stopped: false,
        seen,
    };

    match root {
        None => {
            let mut path = Vec::new();
            ctx.children(tree, &mut path, 0, None);
        }
        Some(root_path) => match follow(tree, root_path) {
            Some(node) => {
                let mut path = root_path.to_vec();
                ctx.visit(node, &mut path, 0, None);
            }
            None => {
                return Rendered {
                    text: "That part of the window has changed. Take a new snapshot without root.".into(),
                    refs: Vec::new(),
                    seen: ctx.seen,
                }
            }
        },
    }

    let mut text = ctx.lines.join("\n");
    let mut notes = Vec::new();
    ctx.omitted.sort_by(|a, b| b.1.cmp(&a.1));
    for (under, n) in ctx.omitted.iter().take(3) {
        notes.push(match under {
            Some(r) => format!("… {n} more under e{r} — desktop_snapshot root:\"e{r}\" to see them"),
            None => format!("… {n} more at the top level, not shown"),
        });
    }
    if ctx.omitted.len() > 3 {
        notes.push(format!("… and more in {} other places", ctx.omitted.len() - 3));
    }
    for under in ctx.walk_stopped.iter().flatten().take(3) {
        notes.push(format!("… the app's tree goes deeper under e{under} — root:\"e{under}\" to read it"));
    }
    if ctx.stopped {
        notes.push(format!("(stopped at {} elements)", caps.max_nodes));
    }
    if ctx.printed == 0 {
        notes.push(
            "(nothing readable here — this app may not expose its UI. Try window:\"menu\" for its menu bar, keyboard shortcuts with action:\"keys\", or a cheaper route from the nyra-desktop skill.)"
                .into(),
        );
    }
    if ctx.seen.irreversible_any {
        notes.push(
            "⚠ irreversible = it sends, deletes, buys or submits. Ask the user before pressing it, then pass confirmed:true."
                .into(),
        );
    }
    if !notes.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&notes.join("\n"));
    }

    Rendered { text, refs: ctx.refs, seen: ctx.seen }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(role: Role, label: &str, children: Vec<RawElement<u32>>) -> RawElement<u32> {
        RawElement {
            handle: 0,
            role,
            label: label.into(),
            value: None,
            frame: Some(Rect { x: 10.0, y: 10.0, w: 50.0, h: 20.0 }),
            enabled: true,
            focused: false,
            offscreen: None,
            secure: false,
            children,
            children_truncated: false,
        }
    }

    fn window(children: Vec<RawElement<u32>>) -> RawElement<u32> {
        el(Role::Other("window".into()), "", children)
    }

    const WIN: Rect = Rect { x: 0.0, y: 0.0, w: 800.0, h: 600.0 };

    fn draw(tree: &RawElement<u32>, caps: Caps) -> Rendered<u32> {
        let mut next = 1;
        render(tree, Some(&WIN), None, &mut next, caps)
    }

    #[test]
    fn unlabeled_groups_collapse_and_their_children_move_up() {
        let tree = window(vec![el(Role::Group, "", vec![el(Role::Group, "", vec![el(Role::Button, "Send", vec![])])])]);
        let r = draw(&tree, Caps::default());
        assert_eq!(r.text.lines().next().unwrap(), "[e1] button \"Send\" ⚠ irreversible");
        assert_eq!(r.refs.len(), 1);
        // The path still records the real route, so it can be walked again.
        assert_eq!(r.refs[0].entry.path.len(), 3);
    }

    #[test]
    fn invisible_things_are_skipped() {
        let mut off = el(Role::Button, "Hidden", vec![]);
        off.offscreen = Some(true);
        let mut zero = el(Role::Button, "Spacer", vec![]);
        zero.frame = Some(Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
        let mut away = el(Role::Button, "Scrolled away", vec![]);
        away.frame = Some(Rect { x: 0.0, y: 5000.0, w: 50.0, h: 20.0 });
        let tree = window(vec![off, zero, away, el(Role::Button, "Visible", vec![])]);
        let r = draw(&tree, Caps::default());
        assert_eq!(r.text, "[e1] button \"Visible\"");
    }

    #[test]
    fn text_repeating_its_button_is_dropped() {
        let tree = window(vec![el(Role::Button, "OK", vec![el(Role::Text, "OK", vec![])])]);
        assert_eq!(draw(&tree, Caps::default()).refs.len(), 1);
    }

    #[test]
    fn refs_keep_counting_across_snapshots() {
        let tree = window(vec![el(Role::Button, "A", vec![]), el(Role::Button, "B", vec![])]);
        let mut next = 1;
        render(&tree, Some(&WIN), None, &mut next, Caps::default());
        let second = render(&tree, Some(&WIN), None, &mut next, Caps::default());
        // A ref never names two things, so an old one can be told from a new one.
        assert!(second.text.starts_with("[e3]"), "{}", second.text);
    }

    #[test]
    fn says_where_it_stopped_and_how_to_see_the_rest() {
        let deep = el(Role::List, "Messages", (0..10).map(|i| el(Role::Row, &format!("m{i}"), vec![])).collect());
        let tree = window(vec![deep]);
        let r = draw(&tree, Caps { max_depth: 14, max_nodes: 4 });
        assert!(r.text.contains("… 7 more under e1 — desktop_snapshot root:\"e1\""), "{}", r.text);
        assert!(r.text.contains("(stopped at 4 elements)"));

        let r = draw(&tree, Caps { max_depth: 1, max_nodes: 400 });
        assert!(r.text.contains("10 more under e1"), "{}", r.text);
    }

    #[test]
    fn a_root_renders_just_that_part() {
        let tree = window(vec![
            el(Role::Toolbar, "Tools", vec![el(Role::Button, "Bold", vec![])]),
            el(Role::List, "Messages", vec![el(Role::Row, "Hello", vec![])]),
        ]);
        let first = draw(&tree, Caps::default());
        let list = first.refs.iter().find(|r| r.entry.label == "Messages").unwrap();
        let mut next = 100;
        let part = render(&tree, Some(&WIN), Some(&list.entry.path), &mut next, Caps::default());
        assert!(part.text.starts_with("[e100] list \"Messages\""), "{}", part.text);
        assert!(!part.text.contains("Bold"));
    }

    #[test]
    fn a_password_field_is_marked_and_its_value_never_printed() {
        let mut pw = el(Role::TextField, "Password", vec![]);
        pw.secure = true;
        pw.value = Some("hunter2".into());
        pw.focused = true;
        let r = draw(&window(vec![pw]), Caps::default());
        assert!(!r.text.contains("hunter2"));
        assert!(r.text.contains("password: not readable"));
        assert!(r.seen.focused_secure);
    }

    #[test]
    fn finds_a_moved_element_by_role_and_label_but_never_guesses() {
        let before = window(vec![el(Role::Button, "Send", vec![]), el(Role::Button, "Cancel", vec![])]);
        let r = draw(&before, Caps::default());
        let send = r.refs.iter().find(|r| r.entry.label == "Send").unwrap().entry.clone();

        // Something appeared above it: the path is wrong, the label is unique.
        let moved = window(vec![el(Role::Text, "Draft saved", vec![]), el(Role::Button, "Cancel", vec![]), el(Role::Button, "Send", vec![])]);
        assert_eq!(find(&moved, &send.path, &send.role, &send.label).unwrap().label, "Send");

        // Its label changed: not the same thing any more.
        let renamed = window(vec![el(Role::Button, "Sent", vec![]), el(Role::Button, "Cancel", vec![])]);
        assert!(find(&renamed, &send.path, &send.role, &send.label).is_none());

        // Two of them and the path no longer holds: ambiguous, so no.
        let two = window(vec![el(Role::Text, "x", vec![]), el(Role::Button, "Send", vec![]), el(Role::Button, "Send", vec![])]);
        assert!(find(&two, &send.path, &send.role, &send.label).is_none());
    }

    #[test]
    fn records_where_the_irreversible_things_are() {
        let r = draw(&window(vec![el(Role::Button, "Delete", vec![])]), Caps::default());
        assert!(r.seen.irreversible_any);
        assert_eq!(r.seen.danger.len(), 1);
        assert!(r.text.contains("Ask the user before pressing it"));
    }

    #[test]
    fn an_empty_window_says_what_to_try_instead() {
        let r = draw(&window(vec![el(Role::Group, "", vec![])]), Caps::default());
        assert!(r.text.contains("window:\"menu\""), "{}", r.text);
    }
}
