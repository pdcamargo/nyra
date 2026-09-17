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

// `window.api` stub — all 14 namespaces.
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
    claude: { dispose: noop, query: noop, abort: noop, respondPermission: noop },
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
      pickFiles: () => Promise.resolve([]),
      saveFile: () => Promise.resolve(null)
    },
    system: { homedir: () => Promise.resolve('/home/test') },
    appWindow: { startDragging: noop, toggleMaximize: noop },
    terminal: { spawn: noop, write: noop, resize: noop, kill: noop, onData: unsub, onExit: unsub },
    browser: {
      status: noop, configure: noop, install: noop,
      openChat: noop, closeChat: noop, touch: noop,
      tabCreate: noop, tabClose: noop, tabNavigate: noop, tabHistory: noop, tabList: noop,
      onEvent: unsub
    },
    agents: { list: () => Promise.resolve([]) },
    memory: {
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(''),
      write: noop,
      delete: noop
    },
    skills: { list: () => Promise.resolve([]), write: noop, delete: noop },
    settings: { sync: noop },
    fs: {
      readFile: () => Promise.resolve(''),
      readImage: () => Promise.resolve({ error: 'Image not found.', missing: true }),
      revertFile: () => Promise.resolve({ success: true }),
      listFiles: () => Promise.resolve([])
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
      kill: noop,
      clear: noop,
      onUpdate: unsub
    },
    login: { start: noop, input: noop, resize: noop, cancel: noop, onData: unsub, onExit: unsub }
  }
})
