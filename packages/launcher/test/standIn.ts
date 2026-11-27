/** A stand-in app with no conversation registry, no composer and no message search: what Leaf and Ship look like to the box. */
import type { LauncherHost } from '../src/host.js'
import { launcherApps } from '../src/launcherActions.js'

export const WORDS: LauncherHost['words'] = {
  anywhere: 'Anywhere in Leaf',
  inOpen: 'On this page',
  search: 'Search Leaf, or choose an app',
  searchOrAsk: 'Search, or ask about this page',
  openGroup: 'This page',
  nothingOpen: 'Open a page to ask about it.',
  nothingYet: 'This page is empty.',
  reading: 'Reading the page…',
  downloadModel: 'Download the on-device model to ask about pages',
}

export const PLAN = { id: '30023:aa:plan', title: 'Launch plan' }

export function standIn(over: Partial<LauncherHost> = {}): LauncherHost {
  return {
    // An app the registry does not list: none of the apps is the one the box runs in.
    apps: launcherApps('leaf'),
    mark: () => null,
    words: WORDS,
    path: { pathname: '/page/plan', search: '' },
    navigate: () => {},
    people: [{ id: 'p1', name: 'Katerina Novak', role: 'Designer' }],
    openPerson: () => {},
    file: { glyph: () => 'topic', open: () => {}, isOpen: () => false },
    useFileSearch: (query) => (query.trim() ? { state: { kind: 'done', count: 1 }, hits: [PLAN] } : { state: { kind: 'idle' }, hits: [] }),
    plain: (body) => body,
    manifests: { creatableUnder: async () => null, applyAction: async () => ({ ok: true }), resolveObject: async () => null },
    model: {
      hasPromptApi: () => true,
      prefillAvailability: async () => 'available',
      canPrefill: async () => true,
      downloadModel: async () => true,
      promptForText: async () => null,
      promptForObject: async () => null,
    },
    showSource: () => true,
    // No form is opened here: the fields are drawn in Peek's suite, through Peek's host.
    form: { references: {} as LauncherHost['form']['references'], mentions: {} as LauncherHost['form']['mentions'], referenceView: () => null, personField: () => null },
    useReportFailure: () => {},
    ...over,
  }
}
