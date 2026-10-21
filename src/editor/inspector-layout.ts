interface InspectorState {
  page: string;
  scroll: Map<string, number>;
  disclosures: Map<string, boolean>;
}
const states = new Map<string, InspectorState>();
type Page = { name: string; selectors: string[] };
const sectionWith = (id: string) => `.control-section:has(#${id})`;
const field = (id: string) => `label:has(> #${id})`;

/** Presentation only: keep the original controls and their authoring bindings. */
export function renderCompactInspector(
  root: HTMLElement,
  html: string,
  tool: string,
  sculptTool: string,
) {
  const previousTool = root.dataset.inspectorTool;
  const previousLodCount = root.querySelectorAll('.lod-entry').length;
  const previous = previousTool ? states.get(previousTool) : undefined;
  const inspector = root.parentElement!;
  const focused = inspector.contains(document.activeElement)
    ? document.activeElement?.id
    : undefined;
  if (previous) {
    previous.scroll.set(previous.page, root.scrollTop);
    root.querySelectorAll<HTMLDetailsElement>('details').forEach((details) => {
      previous.disclosures.set(disclosureKey(details), details.open);
    });
  }
  const state = states.get(tool) ?? {
    page: '',
    scroll: new Map<string, number>(),
    disclosures: new Map<string, boolean>(),
  };
  states.set(tool, state);
  inspector.querySelector(':scope > .inspector-chrome')?.remove();
  root.innerHTML = html;
  root.dataset.inspectorTool = tool;
  const source = document.createElement('div');
  source.append(...root.childNodes);
  const chrome = document.createElement('div');
  chrome.className = 'inspector-chrome';
  const heading = source.querySelector('.inspector-heading');
  if (heading) chrome.append(heading);
  inspector.insertBefore(chrome, root);

  const move = (parent: Element, selectors: string[]) => {
    for (const selector of selectors)
      source.querySelectorAll(selector).forEach((node) => parent.append(node));
  };
  const fold = (selector: string, open = false) => {
    const section = source.querySelector(selector);
    const title = section?.querySelector(':scope > h3');
    if (!section || !title) return;
    const details = document.createElement('details');
    details.className = 'inspector-disclosure';
    details.open = open;
    const summary = document.createElement('summary');
    summary.textContent = title.textContent;
    title.remove();
    details.append(summary, ...section.childNodes);
    section.append(details);
  };
  let pages: Page[] = [];
  if (tool === 'sculpt') {
    fold(sectionWith('alpha-kind'), sculptTool === 'stamp');
    fold(sectionWith('open-upland'));
    pages = [
      {
        name: 'Brush',
        selectors: [
          '.tool-grid',
          sectionWith('radius'),
          '.brush-preview',
          sectionWith('alpha-kind'),
        ],
      },
      {
        name: 'Terrain',
        selectors: [
          sectionWith('generate'),
          '.erosion-entry',
          sectionWith('open-upland'),
        ],
      },
      {
        name: 'Files',
        selectors: [
          sectionWith('heightmap-min'),
          sectionWith('sculpt-preset-name'),
        ],
      },
    ];
  } else if (tool === 'materials') {
    move(chrome, ['.material-tabs']);
    fold(sectionWith('load-surface-preset'));
    pages = [
      { name: 'Surface', selectors: [sectionWith('mat-name')] },
      {
        name: 'Maps',
        selectors: [
          '#import-material-set',
          '.import-launch-note',
          sectionWith('texture-resolution'),
          sectionWith('load-surface-preset'),
        ],
      },
      { name: 'Rules', selectors: [sectionWith('min-height')] },
      { name: 'Paint', selectors: [sectionWith('radius')] },
    ];
  } else if (tool === 'foliage') {
    move(chrome, [field('brush-select')]);
    // Keep the model context accessible on every page that edits a model.
    const model = source.querySelector(field('model-entry'));
    if (model) {
      model.classList.add('inspector-model-context');
      model.setAttribute('data-inspector-context', 'Models');
      chrome.append(model);
    }
    fold(sectionWith('crush-enabled'));
    fold('.foliage-flexibility-controls');
    fold(sectionWith('prune-assets'));
    source
      .querySelectorAll<HTMLElement>('.lod-entry')
      .forEach((entry, index) => {
        const title = entry.querySelector('h4');
        const distance = entry.querySelector<HTMLInputElement>(
          '[id^="lod-distance-"]',
        );
        const density = entry.querySelector<HTMLInputElement>(
          '[id^="lod-density-"]',
        );
        const details = document.createElement('details');
        details.className = 'inspector-lod';
        details.dataset.disclosureKey = `lod-${index}`;
        details.open =
          index === 0 ||
          (previousTool === tool &&
            previousLodCount > 0 &&
            index >= previousLodCount);
        const summary = document.createElement('summary');
        summary.textContent = `${title?.textContent ?? 'LOD'} · ${distance?.value ?? '0'} m · ${density?.value ?? '100'}%`;
        title?.remove();
        details.append(summary, ...entry.childNodes);
        entry.append(details);
      });
    pages = [
      {
        name: 'Paint',
        selectors: [
          '.button-row:has(#erase-foliage)',
          sectionWith('density'),
          sectionWith('min-weight'),
        ],
      },
      {
        name: 'Models',
        selectors: [sectionWith('brush-name'), sectionWith('foliage-model')],
      },
      {
        name: 'Effects',
        selectors: [
          '.foliage-shading-controls',
          sectionWith('crush-enabled'),
          '.foliage-flexibility-controls',
        ],
      },
      { name: 'Detail', selectors: ['.foliage-detail-controls'] },
      {
        name: 'Library',
        selectors: [
          '#import-foliage',
          '.import-launch-note',
          sectionWith('default-foliage'),
          '.button-row:has(#save-brush)',
          sectionWith('prune-assets'),
        ],
      },
    ];
  } else if (tool === 'water' && source.querySelector('#water-body')) {
    move(chrome, ['#water-context']);
    pages = [
      { name: 'Shape', selectors: ['#water-shape'] },
      { name: 'Appearance', selectors: ['#water-appearance'] },
      { name: 'Waves', selectors: ['#water-waves'] },
      { name: 'Shore', selectors: ['#water-shore'] },
    ];
  } else if (tool === 'project') {
    pages = [
      { name: 'Files', selectors: [sectionWith('project-file-location')] },
      {
        name: 'Terrain',
        selectors: [sectionWith('eye-height'), sectionWith('terrain-size')],
      },
    ];
  } else if (tool === 'light') {
    // Separate the existing environment controls without touching rendering code.
    const group = (name: string, id: string, selectors: string[]) => {
      const section = document.createElement('section');
      section.className = 'control-section';
      section.id = id;
      const title = document.createElement('h3');
      title.textContent = name;
      section.append(title);
      move(section, selectors);
      source.append(section);
    };
    group(
      'Sun & exposure',
      'inspector-sun',
      [
        'environment-preset',
        'sunAzimuth',
        'sunElevation',
        'sunIntensity',
        'exposure',
        'toneMapping',
      ].map((id) => field(id === 'environment-preset' ? id : 'env-' + id)),
    );
    group(
      'Fog',
      'inspector-fog',
      ['fogEnabled', 'fogColor', 'fogNear', 'fogFar'].map((id) =>
        field('env-' + id),
      ),
    );
    group(
      'Shadows',
      'inspector-shadows',
      [
        'shadows',
        'shadowResolution',
        'shadowCascades',
        'shadowDistance',
        'shadowBias',
        'shadowNormalBias',
        'shadowPadding',
      ].map((id) => field('env-' + id)),
    );
    group('Image stability', 'inspector-image', [
      field('env-temporalAA'),
      field('env-temporalSharpness'),
    ]);
    const colors = source.querySelector<HTMLDetailsElement>(
      '.environment-controls details',
    );
    if (colors) {
      colors.querySelector('summary')!.textContent =
        'Environment colors & tips';
    }
    const indirect = source.querySelectorAll(
      '.environment-controls details:has(#env-ao-enabled), .environment-controls details:has(#env-canopy-enabled)',
    );
    if (indirect.length) {
      const section = document.createElement('section');
      section.className = 'control-section inspector-contact';
      section.append(...indirect);
      source.append(section);
    }
    pages = [
      { name: 'Sun', selectors: ['.daylight-controls', '#inspector-sun'] },
      {
        name: 'Sky & fog',
        selectors: ['.environment-controls', '#inspector-fog'],
      },
      {
        name: 'Shadows',
        selectors: ['#inspector-shadows', '.inspector-contact'],
      },
      {
        name: 'View',
        selectors: ['#inspector-image', sectionWith('low-poly')],
      },
    ];
  } else if (tool === 'props') {
    pages = [
      { name: 'Place', selectors: [sectionWith('prop-model')] },
      { name: 'Selected', selectors: [sectionWith('prop-x'), '.empty-state'] },
      { name: 'Assets', selectors: [sectionWith('prune-assets')] },
    ];
    const selected = source.querySelector(
      'section:has(#prop-x) h3',
    )?.textContent;
    if (selected && selected !== root.dataset.selectedProp)
      state.page = 'Selected';
    root.dataset.selectedProp = selected ?? '';
  }

  const nav = document.createElement('div');
  nav.className = 'inspector-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', `${tool} settings`);
  // Keep navigation outside the scrolling body, so focusing a tab cannot reset it.
  if (pages.length) {
    if (tool === 'water') chrome.append(nav);
    else
      chrome.insertBefore(
        nav,
        heading ? heading.nextSibling : chrome.firstChild,
      );
  }
  const panels: HTMLElement[] = [];
  const buttons: HTMLButtonElement[] = [];
  for (const [index, page] of pages.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = page.name;
    button.id = `inspector-tab-${tool}-${index}`;
    button.setAttribute('role', 'tab');
    const panel = document.createElement('div');
    panel.className = 'inspector-page';
    panel.id = `inspector-page-${tool}-${index}`;
    panel.dataset.inspectorPage = page.name;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panel.tabIndex = -1;
    button.setAttribute('aria-controls', panel.id);
    move(panel, page.selectors);
    nav.append(button);
    root.append(panel);
    panels.push(panel);
    buttons.push(button);
  }
  // Retain future/unclassified controls instead of silently dropping them.
  (panels[0] ?? root).append(...source.childNodes);

  root.querySelectorAll<HTMLElement>('.control-section').forEach((section) => {
    const notes = [
      ...section.querySelectorAll<HTMLParagraphElement>(
        ':scope > .field-note, :scope > .inspector-disclosure > .field-note',
      ),
    ].filter(
      (note) =>
        !note.id &&
        !note.querySelector('a') &&
        !/replac|remov|clear|undo|clip|maximum/i.test(note.textContent ?? ''),
    );
    if (!notes.length) return;
    const help = document.createElement('details');
    help.className = 'inspector-help';
    const summary = document.createElement('summary');
    summary.textContent = 'Details & tips';
    help.append(summary, ...notes);
    (section.querySelector(':scope > .inspector-disclosure') ?? section).append(
      help,
    );
  });
  root.querySelectorAll<HTMLDetailsElement>('details').forEach((details) => {
    const remembered = state.disclosures.get(disclosureKey(details));
    if (remembered !== undefined) details.open = remembered;
  });
  root.querySelectorAll('.range-field').forEach((label) => {
    const output = label.querySelector('output');
    if (output) label.append(output);
  });
  const activate = (index: number, rememberScroll = true) => {
    if (rememberScroll) state.scroll.set(state.page, root.scrollTop);
    state.page = pages[index].name;
    buttons.forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    const model = chrome.querySelector<HTMLElement>('.inspector-model-context');
    if (model)
      model.hidden = !['Models', 'Effects', 'Detail'].includes(state.page);
    root.scrollTop = state.scroll.get(state.page) ?? 0;
  };
  buttons.forEach((button, index) => {
    button.onclick = () => activate(index);
    button.onkeydown = (event) => {
      let next: number;
      if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowLeft')
        next = (index + buttons.length - 1) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else return;
      event.preventDefault();
      activate(next);
      buttons[next].focus({ preventScroll: true });
    };
  });
  if (pages.length)
    activate(
      Math.max(
        0,
        pages.findIndex((page) => page.name === state.page),
      ),
      false,
    );
  else root.scrollTop = state.scroll.get('') ?? 0;
  updateInspectorTool(root, sculptTool);
  if (previousTool === tool && focused) {
    const replacement = document.getElementById(focused);
    if (
      replacement &&
      inspector.contains(replacement) &&
      replacement.getClientRects().length
    )
      replacement.focus({ preventScroll: true });
  }
}

function disclosureKey(details: HTMLDetailsElement) {
  if (details.dataset.disclosureKey) return details.dataset.disclosureKey;
  const section = details.closest('.control-section');
  const title = section?.querySelector(
    ':scope > h3, :scope > details > summary',
  )?.textContent;
  return `${title ?? ''}/${details.querySelector(':scope > summary')?.textContent ?? ''}`;
}

/** Keep brush-specific settings in context without removing bound controls. */
export function updateInspectorTool(root: HTMLElement, tool: string) {
  if (root.dataset.inspectorTool !== 'sculpt') return;
  const show = (id: string, visible: boolean) => {
    const label = root.querySelector<HTMLElement>(field(id));
    if (label) label.hidden = !visible;
  };
  show('target', tool === 'flatten' || tool === 'terrace');
  show('erode-talus', tool === 'erode');
  show('stamp-mode', tool === 'stamp');
  show('stamp-height', tool === 'stamp');
  show(
    'stamp-base',
    tool === 'stamp' &&
      root.querySelector<HTMLSelectElement>('#stamp-mode')?.value === 'set',
  );
  const target = root
    .querySelector('#target')
    ?.closest('label')
    ?.querySelector('span');
  if (target)
    target.textContent =
      tool === 'terrace' ? 'Terrace step' : 'Target elevation';
  if (tool === 'stamp') {
    const alpha = root.querySelector<HTMLDetailsElement>(
      '.inspector-disclosure:has(#alpha-kind)',
    );
    if (alpha) alpha.open = true;
  }
}
