import '@testing-library/jest-dom/vitest'

// Mock localStorage for Zustand persist
const store: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null
  }
})

// jsdom ships no matchMedia, and useResolvedTheme asks it whether the system
// prefers light. Defaults to "no", i.e. dark, which is the app's own default.
if (!globalThis.matchMedia) {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })
  })
}

// Mock crypto.randomUUID
if (!globalThis.crypto?.randomUUID) {
  let counter = 0
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      randomUUID: () => `test-uuid-${++counter}`
    }
  })
}

// `window.api` stub — every namespace a component reaches on mount.
//
// It used to cover 5, which was enough for the store tests but meant rendering
// <App/> threw: it calls processes.onUpdate on mount. Component tests need the
// whole surface present.
//
// The renderer only ever reaches the backend through this object. Without a stub
// those calls throw in jsdom and whatever is under test fails for a reason that
// has nothing to do with it. Every method resolves to a benign empty value; a
// test that cares about a specific response overrides that one method itself.
const noop = (): Promise<undefined> => Promise.resolve(undefined)
/** Subscribe helpers hand back an unsubscribe function synchronously. */
const unsub = (): (() => void) => () => {}

Object.defineProperty(globalThis, 'api', {
  writable: true,
  value: {
    claude: {
      dispose: noop,
      query: noop,
      abort: noop,
      respondPermission: noop,
      checkBinary: noop,
      // No CLI here: the account cache keeps what it had rather than guessing.
      accountStatus: () => Promise.resolve({ loggedIn: false, error: 'no claude in tests' })
    },
    git: {
      branch: () => Promise.resolve(''),
      isRepo: () => Promise.resolve(false),
      mainWorktreeRoot: () => Promise.resolve(null),
      worktreeList: () => Promise.resolve([]),
      diffStat: () => Promise.resolve({ filesChanged: 0, insertions: 0, deletions: 0 }),
      worktreeCreateManaged: () => Promise.resolve({ path: '', branch: '' }),
      worktreeSnapshot: () => Promise.resolve({ success: true }),
      worktreeRemove: () => Promise.resolve({ success: true }),
      worktreeRestore: () => Promise.resolve({ success: false }),
      snapshotExists: () => Promise.resolve(false),
      snapshotDiscard: noop
    },
    dialog: {
      pickFolder: () => Promise.resolve(null),
      pickFile: () => Promise.resolve(null),
      pickImage: () => Promise.resolve(null),
      pickFiles: () => Promise.resolve([]),
      saveFile: () => Promise.resolve(null)
    },
    system: { homedir: () => Promise.resolve('/home/test') },
    environment: {
      info: () =>
        Promise.resolve({
          kind: 'host',
          distro: null,
          reachable: true,
          claudeFound: true,
          mirroredNetworking: false,
          cwdInEnv: '',
          homeInEnv: null
        })
    },
    appWindow: {
      startDragging: noop,
      toggleMaximize: noop,
      minimize: noop,
      close: noop,
      isMaximized: () => Promise.resolve(false),
      onResized: () => Promise.resolve(() => {})
    },
    terminal: { spawn: noop, write: noop, resize: noop, kill: noop, onData: unsub, onExit: unsub },
    browser: {
      // A test machine has no Chromium, and saying so is the honest default —
      // `noop` resolved undefined, which every caller then read `.ok` off.
      status: () => Promise.resolve({ ok: true, chromium: 'missing' }),
      configure: noop, install: noop,
      openChat: () => Promise.resolve({ ok: false, error: 'no browser in tests' }),
      closeChat: noop, touch: noop,
      tabCreate: () => Promise.resolve({ ok: false, error: 'no browser in tests' }),
      tabClose: noop, tabNavigate: noop, tabHistory: noop, tabSetViewport: noop, targetScreenshot: noop,
      tabList: () => Promise.resolve({ ok: true, tabs: [] }),
      onEvent: unsub
    },
    agents: { list: () => Promise.resolve([]) },
    memory: {
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(''),
      write: noop,
      delete: noop
    },
    skills: {
      list: () => Promise.resolve([]),
      write: noop,
      delete: noop,
      bundledNames: () => Promise.resolve([]),
      restoreBundled: noop
    },
    settings: { sync: noop },
    keepAwake: {
      status: () =>
        Promise.resolve({ holding: false, busy: false, onBattery: false, chats: 0, monitors: 0, tasks: 0, flows: 0, since: null }),
      onUpdate: unsub
    },
    systemAccess: { list: () => Promise.resolve([]), fix: noop },
    fonts: { list: () => Promise.resolve([]) },
    fs: {
      readFile: () => Promise.resolve(''),
      readImage: () => Promise.resolve({ error: 'Image not found.', missing: true }),
      revertFile: () => Promise.resolve({ success: true }),
      listFiles: () => Promise.resolve([]),
      listDir: () =>
        Promise.resolve({ path: '', entries: [], truncated: false, ignoreApplied: true }),
      readTextFile: () => Promise.resolve({ kind: 'missing' }),
      statFile: () => Promise.resolve({ exists: false, size: 0, mtimeMs: 0, ino: 0 }),
      searchTree: () => Promise.resolve({ paths: [], truncated: false }),
      listProjectFiles: () => Promise.resolve({ paths: [], truncated: false, isRepo: true }),
      listEditors: () => Promise.resolve([]),
      openWith: () => Promise.resolve({ ok: true }),
      reveal: () => Promise.resolve({ ok: true })
    },
    mcp: { list: () => Promise.resolve([]) },
    hooks: { read: () => Promise.resolve({}), write: noop },
    workflow: {
      list: () => Promise.resolve([]),
      load: () => Promise.resolve(null),
      save: noop,
      delete: noop,
      run: noop,
      abort: noop,
      templates: () => Promise.resolve([]),
      reviewResponse: noop,
      listExecutions: () => Promise.resolve([]),
      getExecution: () => Promise.resolve(null),
      deleteExecution: noop,
      metrics: () => Promise.resolve(null),
      testTrigger: noop,
      generateTriggerToken: () => Promise.resolve(''),
      webhookUrl: () => Promise.resolve(''),
      marketplaceList: () => Promise.resolve([]),
      marketplaceInstall: noop,
      marketplaceShare: noop,
      marketplaceOpen: noop,
      exportWorkflow: noop,
      importWorkflow: noop,
      onEvent: unsub
    },
    processes: {
      list: () => Promise.resolve([]),
      memory: () => Promise.resolve({ bytes: 0, processes: 0 }),
      kill: noop,
      clear: noop,
      onUpdate: unsub
    },
    subagents: { transcript: () => Promise.resolve({ model: null, entries: [] }) },
    login: { start: noop, input: noop, resize: noop, cancel: noop, onData: unsub, onExit: unsub },
    workspace: {
      create: (id: string) => Promise.resolve({ configDir: `/home/test/.nyra/workspaces/${id}/.claude` }),
      copyTranscripts: () => Promise.resolve({ ok: true, projects: 0 }),
      logout: () => Promise.resolve({ ok: true }),
      delete: () => Promise.resolve({ ok: true }),
      syncProjects: () => Promise.resolve({ ok: true })
    },
    // Design work: nothing filed, nothing found. Tests that read a design
    // override `read` (designLoad.test) or these lists themselves.
    design: {
      list: () => Promise.resolve([]),
      onChanged: unsub
    },
    designSystem: {
      list: () => Promise.resolve([]),
      of: () => Promise.resolve(null),
      files: () => Promise.resolve({ ok: false, error: 'no systems in tests' }),
      discover: () => Promise.resolve({ systems: [], designs: 0 })
    },
    comments: {
      list: () => Promise.resolve({ ok: true, comments: [] }),
      onChanged: unsub
    },
    questionnaire: { onChanged: unsub }
  }
})

// Radix positions tooltips and popovers with a ResizeObserver, which jsdom does
// not implement. Without this the observer throws mid-interaction and the click
// it was measuring never lands — a failure that reads as "the button is broken"
// rather than "the environment is missing an API".
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

// Radix also probes these before opening a floating layer. Guarded, because some
// suites run in a node environment with no DOM at all.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = (): boolean => false
    Element.prototype.setPointerCapture = (): void => {}
    Element.prototype.releasePointerCapture = (): void => {}
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => {}
  }
}
