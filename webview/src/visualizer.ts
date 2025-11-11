(function () {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('visualizer');
  const status = document.getElementById('status');
  const viewSelect = document.getElementById('visualizerViewSelect');
  const searchInput = document.getElementById('visualizerSearchInput');
  const chatToggle = document.getElementById('chatToggle');
  const chatPanel = document.getElementById('chatPanel');
  const chatClose = document.getElementById('chatClose');
  const chatReset = document.getElementById('chatReset');
  const chatMessages = document.getElementById('chatMessages');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const chatStatus = document.getElementById('chatStatus');
  const chatModelSelect = document.getElementById('chatModelSelect');
  const selectionLineForm = document.getElementById('selectionLineForm');
  const selectionStartInput = document.getElementById('selectionStartInput');
  const selectionEndInput = document.getElementById('selectionEndInput');
  const selectionClearButton = document.getElementById('selectionClearButton');
  const controlDock = document.getElementById('controlDock');
  const controlDockPanel = document.getElementById('controlDockPanel');
  const controlDockToggle = document.getElementById('controlDockToggle');

  if (!container || !status) {
    vscode.postMessage({ type: 'ready' });
    return;
  }

  const graphRoot = document.createElement('section');
  graphRoot.className = 'visualizer-view visualizer-graph-view';
  graphRoot.setAttribute('hidden', 'true');
  container.appendChild(graphRoot);

  const treeRoot = document.createElement('section');
  treeRoot.className = 'visualizer-view visualizer-tree-view';
  treeRoot.setAttribute('hidden', 'true');
  container.appendChild(treeRoot);

  const nodeElements = new Map();
  const pathDepths = new Map();
  const collapsedPathStore = new Map();
  const depthExpandedPathStore = new Map();
  let collapsedPaths = new Set();
  let depthExpandedPaths = new Set();
  let persistedState = typeof vscode.getState === 'function' ? vscode.getState() ?? {} : {};
  let nodePositionStore = persistedState.nodePositions ?? {};
  let nodePositions = new Map();
  let currentDocumentId;
  let currentEdges = [];
  let activeNodeDrag;

  let currentPayload;
  let viewport;
  let canvas;
  let nodesLayer;
  let linksLayer;
  let isPanning = false;
  let panPointerId = null;
  let panStart = { x: 0, y: 0 };
  let panOrigin = { x: 0, y: 0 };
  let hasUserMovedView = false;
  let viewMode = persistedState.viewMode === 'tree' ? 'tree' : 'graph';
  let hasPersistedViewPreference = typeof persistedState.viewMode === 'string';
  let preferredDefaultViewMode = hasPersistedViewPreference ? viewMode : 'graph';
  let graphAutoScale = true;
  let manualGraphScale = 1;
  let graphInitialScale = 1;
  let graphMaxDepth;
  let searchIndex = new Map();
  let currentSearchQuery = '';
  let currentSearchMatch;
  let pendingSearchFocusId;
  const chatMessageMap = new Map();
  let chatPanelVisible = false;
  let awaitingChatKey = false;
  let hasAiKey = false;
  let selectionActive = false;
  let selectionLabel = '';
  let selectionLineRange: { start?: number; end?: number } = {};
  let controlsCollapsed = Boolean(persistedState.controlsCollapsed);
  let needsInitialGraphFocus = true;
  let activeModelProvider = 'openai';

  const NODE_GAP_X = 260;
  const NODE_GAP_Y = 90;
  const CANVAS_PADDING = 96;
  const MANUAL_MIN_SCALE = 0.4;
  const AUTO_MIN_SCALE = 0.02;
  const AUTO_MAX_SCALE = 1.2;
  const AUTO_FIT_PADDING = 0.9;
  const AUTO_VISIBLE_MIN_SCALE = 0.35;
  const MAX_SCALE = 2.5;
  const ICON_TYPES = {
    object: 'object',
    array: 'array',
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    null: 'null',
    link: 'link',
    unknown: 'unknown'
  };
  const EDITABLE_VALUE_KINDS = new Set(['string', 'number', 'boolean', 'null', 'link']);
  const ROOT_PATH = JSON.stringify([]);
  const ICON_SVGS = {
    object:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><path d="M9 5H7c-1.105 0-2 .895-2 2v3c0 1.105-.895 2-2 2 1.105 0 2 .895 2 2v3c0 1.105.895 2 2 2h2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 5h2c1.105 0 2 .895 2 2v3c0 1.105.895 2 2 2-1.105 0-2 .895-2 2v3c0 1.105-.895 2-2 2h-2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    array:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><path d="M5 7h14M5 12h14M5 17h14" stroke-width="2" stroke-linecap="round"/></svg>',
    string:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><path d="M9 7H7l-2 5 2 5h2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 7h2l2 5-2 5h-2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    number:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><path d="M10 4v16M14 4v16M4 10h16M4 14h16" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    boolean:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><rect x="3" y="7" width="18" height="10" rx="5" ry="5" stroke-width="2"/><circle cx="9" cy="12" r="3.5" stroke-width="2"/></svg>',
    null:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="6" stroke-width="2"/><path d="M8.5 8.5 15.5 15.5" stroke-width="2" stroke-linecap="round"/></svg>',
    link:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><path d="M10 13a5 5 0 0 0 7.54.54l1.92-1.92a5 5 0 0 0-7.07-7.07l-1.09 1.09" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11a5 5 0 0 0-7.54-.54l-1.92 1.92a5 5 0 0 0 7.07 7.07l1.09-1.09" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unknown:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><circle cx="12" cy="17" r="1.5" stroke-width="2"/><path d="M12 13v-1.5a3.5 3.5 0 1 0-3.5-3.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  const panState = { x: 0, y: 0, scale: 1 };
  let minScaleLimit = MANUAL_MIN_SCALE;

  if (viewSelect instanceof HTMLSelectElement) {
    viewSelect.value = viewMode;
    viewSelect.addEventListener('change', (event) => {
      const next = event.target.value === 'tree' ? 'tree' : 'graph';
      setViewMode(next);
    });
  }

  if (searchInput instanceof HTMLInputElement) {
    searchInput.addEventListener('input', (event) => {
      const value = event.target.value.trim();
      performSearch(value);
    });
  }

  if (chatToggle instanceof HTMLButtonElement) {
    chatToggle.addEventListener('click', () => {
      if (chatPanelVisible) {
        toggleChatPanel(false);
        return;
      }

      toggleChatPanel(true);
      if (hasAiKey) {
        showChatStatus('');
        return;
      }

      awaitingChatKey = true;
      showChatStatus(getMissingKeyMessage());
      vscode.postMessage({ type: 'chat:ensureKey' });
    });
  }

  if (chatClose instanceof HTMLButtonElement) {
    chatClose.addEventListener('click', () => toggleChatPanel(false));
  }

  if (chatReset instanceof HTMLButtonElement) {
    chatReset.addEventListener('click', () => {
      vscode.postMessage({ type: 'chat:reset' });
      clearChatMessages();
    });
  }

  if (chatForm instanceof HTMLFormElement && chatInput instanceof HTMLTextAreaElement) {
    const submitChatInput = () => {
      const value = chatInput.value.trim();
      if (!value) {
        return;
      }

      if (!hasAiKey) {
        awaitingChatKey = true;
        showChatStatus(getMissingKeyMessage());
        vscode.postMessage({ type: 'chat:ensureKey' });
        return;
      }

      vscode.postMessage({ type: 'chat:send', payload: { text: value } });
      chatInput.value = '';
      showChatStatus('Waiting for response…');
    };

    chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitChatInput();
    });

    chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitChatInput();
      }
    });
  }

  if (chatModelSelect instanceof HTMLSelectElement) {
    chatModelSelect.addEventListener('change', (event) => {
      const value = event.target.value;
      if (!value) {
        return;
      }
      vscode.postMessage({ type: 'chat:setModel', payload: { modelId: value } });
    });
  }

  if (
    selectionLineForm instanceof HTMLFormElement &&
    selectionStartInput instanceof HTMLInputElement &&
    selectionEndInput instanceof HTMLInputElement
  ) {
    selectionLineForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const startValue = parseLineInput(selectionStartInput.value);
      const endValue = parseLineInput(selectionEndInput.value);
      if (typeof startValue !== 'number' || typeof endValue !== 'number') {
        return;
      }
      const normalized = normalizeLineRange(startValue, endValue);
      selectionActive = true;
      selectionLineRange = normalized;
      updateSelectionInputs();
      vscode.postMessage({ type: 'selection:applyLines', payload: { startLine: normalized.start, endLine: normalized.end } });
    });
  }

  if (selectionClearButton instanceof HTMLButtonElement) {
    selectionClearButton.addEventListener('click', () => {
      if (selectionStartInput instanceof HTMLInputElement) {
        selectionStartInput.value = '';
      }
      if (selectionEndInput instanceof HTMLInputElement) {
        selectionEndInput.value = '';
      }
    selectionLineRange = {};
    selectionActive = false;
    updateSelectionInputs();
    vscode.postMessage({ type: 'selection:clear' });
  });
}

  if (controlDockToggle instanceof HTMLButtonElement) {
    controlDockToggle.addEventListener('click', () => {
      setControlsCollapsed(!controlsCollapsed);
    });
  }

  setControlsCollapsed(controlsCollapsed, { persist: false });

  container.addEventListener('click', handleContainerClick);
  container.addEventListener('keydown', handleKeydown);

  window.addEventListener('message', (event) => {
    const { type, payload } = event.data || {};
    if (type === 'render') {
      renderVisualizer(payload);
      return;
    }

    if (type === 'invalid') {
      renderInvalidState(payload);
      return;
    }

    if (type === 'chat:history') {
      renderChatHistory(payload);
      return;
    }

    if (type === 'chat:userMessage') {
      ensureChatPanel();
      setChatMessage(payload?.id, 'user', payload?.text ?? '');
      return;
    }

    if (type === 'chat:assistantStart') {
      ensureChatPanel();
      setChatMessage(payload?.id, 'assistant', '', { pending: true });
      showChatStatus('AI is thinking...');
      return;
    }

    if (type === 'chat:assistantDelta') {
      appendChatDelta(payload?.id, payload?.text ?? '');
      return;
    }

    if (type === 'chat:assistantComplete') {
      finalizeAssistantMessage(payload?.id, payload?.text ?? '', payload?.snippet);
      return;
    }

    if (type === 'chat:error') {
      showChatStatus(payload ?? 'AI error');
      return;
    }

    if (type === 'chat:status') {
      showChatStatus(payload?.state === 'thinking' ? 'AI is thinking...' : '');
      return;
    }

    if (type === 'chat:needsApiKey') {
      showChatStatus(`${getMissingKeyMessage()} Use the command palette to configure it.`);
    }

    if (type === 'chat:ensureKeyResult') {
      hasAiKey = Boolean(payload?.ready);
      if (hasAiKey) {
        awaitingChatKey = false;
        showChatStatus('');
      } else if (awaitingChatKey) {
        showChatStatus(`${getMissingKeyMessage()} Run “JSON Atlas: Set AI API Key”.`);
      }
      return;
    }

    if (type === 'chat:aiStatus') {
      if (typeof payload?.provider === 'string') {
        activeModelProvider = payload.provider;
      }
      hasAiKey = Boolean(payload?.hasKey);
      if (chatPanelVisible && !hasAiKey) {
        showChatStatus(getMissingKeyMessage());
      } else if (chatPanelVisible) {
        showChatStatus('');
      }
      return;
    }

    if (type === 'chat:modelOptions') {
      updateModelSelect(payload);
      return;
    }

    if (type === 'selection:update') {
      applySelectionInfo(payload);
      return;
    }

    if (type === 'visualizer:focusPath') {
      const path = typeof payload === 'string' ? payload : undefined;
      if (!path) {
        return;
      }
      pendingSearchFocusId = path;
      if (viewMode !== 'graph') {
        setViewMode('graph');
        return;
      }
      requestAnimationFrame(() => {
        if (nodeElements.has(path)) {
          focusGraphNode(path);
          pendingSearchFocusId = undefined;
        }
      });
      return;
    }
  });

  vscode.postMessage({ type: 'ready' });

  function persistState(options = { savePositions: true }) {
    if (options.savePositions !== false && currentDocumentId) {
      nodePositionStore[currentDocumentId] = serializePositions(nodePositions);
    }

    persistedState = {
      ...persistedState,
      viewMode,
      nodePositions: nodePositionStore,
      controlsCollapsed
    };
    if (typeof vscode.setState === 'function') {
      vscode.setState(persistedState);
    }
  }

  function switchDocument(documentId) {
    if (currentDocumentId === documentId) {
      return;
    }

    if (currentDocumentId) {
      persistState();
      collapsedPathStore.set(currentDocumentId, new Set(collapsedPaths));
      depthExpandedPathStore.set(currentDocumentId, new Set(depthExpandedPaths));
    }

    currentDocumentId = documentId;
    const stored = nodePositionStore[documentId];
    nodePositions = new Map(stored ? Object.entries(stored) : []);
    const collapsed = collapsedPathStore.get(documentId);
    collapsedPaths = new Set(collapsed instanceof Set ? collapsed : []);
    const expanded = depthExpandedPathStore.get(documentId);
    depthExpandedPaths = new Set(expanded instanceof Set ? expanded : []);
    needsInitialGraphFocus = true;
  }

  function pruneNodePositions(validIds) {
    let changed = false;
    for (const id of Array.from(nodePositions.keys())) {
      if (!validIds.has(id)) {
        nodePositions.delete(id);
        changed = true;
      }
    }

    if (changed) {
      persistState();
    }
  }

  function handleContainerClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const editValueTarget = target.closest('[data-action="edit-value"]');
    if (editValueTarget instanceof HTMLElement) {
      const path = editValueTarget.getAttribute('data-path');
      const literal = editValueTarget.getAttribute('data-literal');
      const kind = editValueTarget.getAttribute('data-kind') ?? 'string';
      const href = editValueTarget.getAttribute('data-href');
      if (!path || !literal) {
        return;
      }

      if (href && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        vscode.postMessage({ type: 'openLink', payload: href });
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      requestEditValue(path, literal, kind);
      return;
    }

    const link = target.closest('[data-open-link="true"]');
    const href = link instanceof HTMLAnchorElement ? link.href : link?.getAttribute('data-href');
    if (href) {
      event.preventDefault();
      vscode.postMessage({ type: 'openLink', payload: href });
      return;
    }

    const renameTarget = target.closest('[data-action="rename"]');
    if (renameTarget instanceof HTMLElement) {
      const path = renameTarget.getAttribute('data-path');
      const currentName = renameTarget.getAttribute('data-key') ?? '';
      if (!path) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      requestRename(path, currentName);
      return;
    }

    const toggle = target.closest('button[data-action="toggle"]');
    if (toggle) {
      const path = toggle.getAttribute('data-path');
      if (!path) {
        return;
      }

      event.preventDefault();
      togglePath(path);
    }
  }

  function handleKeydown(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (
      (event.key === 'Enter' || event.key === ' ') &&
      target.hasAttribute('data-action') &&
      target.getAttribute('data-action') === 'rename'
    ) {
      const path = target.getAttribute('data-path');
      const currentName = target.getAttribute('data-key') ?? '';
      if (!path) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      requestRename(path, currentName);
      return;
    }

    if (
      (event.key === 'Enter' || event.key === ' ') &&
      target.hasAttribute('data-action') &&
      target.getAttribute('data-action') === 'edit-value'
    ) {
      const path = target.getAttribute('data-path');
      const literal = target.getAttribute('data-literal');
      const kind = target.getAttribute('data-kind') ?? 'string';
      if (!path || !literal) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      requestEditValue(path, literal, kind);
    }
  }

  function togglePath(path) {
    if (!path) {
      return;
    }

    if (isAutoCollapsedPath(path)) {
      depthExpandedPaths.add(path);
      rerenderFromState(false);
      focusPath(path);
      return;
    }

    if (collapsedPaths.has(path)) {
      collapsedPaths.delete(path);
      depthExpandedPaths.add(path);
    } else {
      collapsedPaths.add(path);
      depthExpandedPaths.delete(path);
    }

    rerenderFromState(false);
    focusPath(path);
  }

  function rememberPathDepth(pathKey, depth) {
    pathDepths.set(pathKey, depth);
  }

  function getActiveDepthLimit() {
    if (typeof graphMaxDepth === 'number' && Number.isFinite(graphMaxDepth) && graphMaxDepth > 0) {
      return graphMaxDepth;
    }
    return undefined;
  }

  function shouldCollapseByDepth(pathKey, depth) {
    const limit = getActiveDepthLimit();
    if (typeof limit !== 'number') {
      return false;
    }
    return depth >= limit && !depthExpandedPaths.has(pathKey);
  }

  function isAutoCollapsedPath(pathKey) {
    const depth = pathDepths.get(pathKey);
    if (typeof depth !== 'number') {
      return false;
    }
    return shouldCollapseByDepth(pathKey, depth);
  }

  function requestRename(pathKey, currentName) {
    vscode.postMessage({
      type: 'requestRename',
      payload: { path: pathKey, currentName }
    });
  }

  function requestEditValue(pathKey, literal, kind) {
    vscode.postMessage({
      type: 'requestEditValue',
      payload: { path: pathKey, literal, kind }
    });
  }

  function initViewport() {
    viewport = document.createElement('div');
    viewport.className = 'visualizer-viewport';

    canvas = document.createElement('div');
    canvas.className = 'visualizer-canvas';

    linksLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    linksLayer.classList.add('visualizer-links');
    linksLayer.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    nodesLayer = document.createElement('div');
    nodesLayer.className = 'visualizer-nodes';

    canvas.appendChild(linksLayer);
    canvas.appendChild(nodesLayer);
    viewport.appendChild(canvas);
    graphRoot.appendChild(viewport);

    setupPanAndZoom();
  }

  function setupPanAndZoom() {
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }

      if (event.target instanceof HTMLElement && event.target.closest('.visualizer-node')) {
        return;
      }

      isPanning = true;
      hasUserMovedView = true;
      panPointerId = event.pointerId;
      panStart = { x: event.clientX, y: event.clientY };
      panOrigin = { x: panState.x, y: panState.y };
      viewport.setPointerCapture(panPointerId);
      viewport.classList.add('is-panning');
    });

    viewport.addEventListener('pointermove', (event) => {
      if (!isPanning || event.pointerId !== panPointerId) {
        return;
      }

      const deltaX = event.clientX - panStart.x;
      const deltaY = event.clientY - panStart.y;
      panState.x = panOrigin.x + deltaX;
      panState.y = panOrigin.y + deltaY;
      applyPan();
    });

    const endPan = (event) => {
      if (!isPanning || (event.pointerId !== undefined && event.pointerId !== panPointerId)) {
        return;
      }

      isPanning = false;
      const pointerToRelease = panPointerId;
      panPointerId = null;
      viewport.classList.remove('is-panning');
      if (typeof pointerToRelease === 'number') {
        try {
          viewport.releasePointerCapture(pointerToRelease);
        } catch {
          // pointer may already be released; ignore
        }
      }
    };

    viewport.addEventListener('pointerup', endPan);
    viewport.addEventListener('pointercancel', endPan);

    viewport.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        const factor = direction > 0 ? 1.1 : 0.9;
        const nextScale = clamp(panState.scale * factor, minScaleLimit, MAX_SCALE);
        if (nextScale === panState.scale) {
          return;
        }

        hasUserMovedView = true;
        const rect = viewport.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const scaleRatio = nextScale / panState.scale;
        panState.x = offsetX - (offsetX - panState.x) * scaleRatio;
        panState.y = offsetY - (offsetY - panState.y) * scaleRatio;
        panState.scale = nextScale;
        applyPan();
      },
      { passive: false }
    );

    viewport.addEventListener('dblclick', () => {
      resetPan(true);
    });
  }

  function applyPan() {
    if (!canvas) {
      return;
    }
    canvas.style.transform = `translate(${panState.x}px, ${panState.y}px) scale(${panState.scale})`;
  }

  function resetPan(force, scaleOverride) {
    if (!canvas || (!force && hasUserMovedView)) {
      return;
    }

    const host = graphRoot;
    const viewportWidth = host.clientWidth || 1;
    const viewportHeight = host.clientHeight || 1;
    const canvasRect = canvas.getBoundingClientRect();
    const canvasWidth = Number.parseFloat(canvas.style.width) || canvasRect.width || viewportWidth;
    const canvasHeight = Number.parseFloat(canvas.style.height) || canvasRect.height || viewportHeight;

    const targetScale = typeof scaleOverride === 'number' ? scaleOverride : graphInitialScale;
    const normalizedScale = typeof targetScale === 'number' ? targetScale : 1;
    panState.scale = clamp(normalizedScale, minScaleLimit, MAX_SCALE);
    panState.x = (viewportWidth - canvasWidth) / 2;
    panState.y = Math.min(32, (viewportHeight - canvasHeight) / 2);
    applyPan();
  }

  function updateMinScaleLimit(initialScale) {
    if (graphAutoScale && typeof initialScale === 'number' && initialScale < MANUAL_MIN_SCALE) {
      minScaleLimit = clamp(initialScale, AUTO_MIN_SCALE, MANUAL_MIN_SCALE);
      return;
    }
    minScaleLimit = MANUAL_MIN_SCALE;
  }

  function rerenderFromState(force) {
    if (typeof currentPayload === 'undefined') {
      return;
    }

    if (force && viewMode === 'graph') {
      resetPan(true, graphInitialScale);
      hasUserMovedView = false;
    }

    renderData(currentPayload);
  }

  function setViewMode(mode) {
    const normalized = mode === 'tree' ? 'tree' : 'graph';
    if (normalized === viewMode) {
      return;
    }

    viewMode = normalized;
    hasPersistedViewPreference = true;
    if (viewSelect instanceof HTMLSelectElement) {
      viewSelect.value = normalized;
    }

    persistState();
    if (currentPayload) {
      renderData(currentPayload);
    }
  }

  function renderVisualizer(payload) {
    const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
    const documentId =
      payload && typeof payload === 'object' && typeof payload.documentId === 'string'
        ? payload.documentId
        : undefined;
    const defaultViewMode =
      payload && typeof payload === 'object' && typeof payload.defaultViewMode === 'string'
        ? payload.defaultViewMode
        : undefined;

    const initialSelectionInfo =
      payload && typeof payload === 'object' && 'selectionInfo' in payload ? payload.selectionInfo : undefined;
    applySelectionInfo(initialSelectionInfo);

    if (payload && typeof payload === 'object') {
      if (payload.focusRoot) {
        if (viewMode !== 'graph') {
          setViewMode('graph');
        }
        pendingSearchFocusId = ROOT_PATH;
      }
      if (payload.resetLayout && currentDocumentId) {
        nodePositions = new Map();
        nodePositionStore[currentDocumentId] = {};
      }
      if (payload.resetView || payload.focusRoot) {
        needsInitialGraphFocus = true;
        hasUserMovedView = false;
        pendingSearchFocusId = undefined;
        currentSearchMatch = undefined;
      }
      if (typeof payload.graphAutoScale === 'boolean') {
        graphAutoScale = payload.graphAutoScale;
      }
      if (typeof payload.graphInitialScale === 'number') {
        manualGraphScale = clampScale(payload.graphInitialScale);
      }
      if (typeof payload.graphMaxDepth === 'number') {
        graphMaxDepth = Number.isFinite(payload.graphMaxDepth) && payload.graphMaxDepth > 0 ? Math.floor(payload.graphMaxDepth) : undefined;
      } else if (payload.graphMaxDepth === null) {
        graphMaxDepth = undefined;
      }
    }

    if (documentId) {
      switchDocument(documentId);
    } else if (!currentDocumentId) {
      currentDocumentId = 'default';
      nodePositions = new Map();
      needsInitialGraphFocus = true;
    }

    if (defaultViewMode) {
      const normalized = defaultViewMode === 'tree' ? 'tree' : 'graph';
      preferredDefaultViewMode = normalized;
      if (!hasPersistedViewPreference && viewMode !== normalized) {
        viewMode = normalized;
        if (viewSelect instanceof HTMLSelectElement) {
          viewSelect.value = normalized;
        }
      }
    }

    if (typeof data === 'undefined') {
      return;
    }

    currentPayload = data;
    renderData(data);
  }

  function renderData(data) {
    hideStatus();
    pathDepths.clear();
    const graphData = buildGraph(data);
    updateSearchIndex(graphData.nodes);

    if (viewMode === 'tree') {
      renderTreeView(data);
    } else {
      renderGraph(graphData);
    }
  }

  function renderGraph(graph) {
    graphRoot.removeAttribute('hidden');
    treeRoot.setAttribute('hidden', 'true');

    if (!viewport) {
      initViewport();
    }

    nodesLayer.innerHTML = '';
    linksLayer.innerHTML = '';
    nodeElements.clear();

    canvas.style.width = `${graph.size.width}px`;
    canvas.style.height = `${graph.size.height}px`;
    linksLayer.setAttribute('width', String(graph.size.width));
    linksLayer.setAttribute('height', String(graph.size.height));
    linksLayer.setAttribute('viewBox', `0 0 ${graph.size.width} ${graph.size.height}`);

    graph.nodes.forEach((node) => {
      const element = createGraphNodeElement(node);
      nodesLayer.appendChild(element);
      nodeElements.set(node.id, { node, element });
    });

    currentEdges = graph.edges;
    pruneNodePositions(new Set(graph.nodes.map((node) => node.id)));
    drawEdges(currentEdges);

    const targetScale = graphAutoScale ? computeAutoScale(graph.size, graph.nodes.length) : clampScale(manualGraphScale);
    graphInitialScale = targetScale;
    updateMinScaleLimit(graphInitialScale);

    if (hasUserMovedView) {
      resetPan(false);
    } else {
      resetPan(true, graphInitialScale);
      hasUserMovedView = false;
    }

    applyPan();
    applySearchHighlight();
    if (pendingSearchFocusId) {
      focusGraphNode(pendingSearchFocusId);
      pendingSearchFocusId = undefined;
      needsInitialGraphFocus = false;
    } else if (currentSearchMatch) {
      highlightGraphNode(currentSearchMatch);
      needsInitialGraphFocus = false;
    } else if (needsInitialGraphFocus) {
      focusGraphNode(ROOT_PATH);
      needsInitialGraphFocus = false;
    }
  }

  function renderTreeView(payload) {
    treeRoot.removeAttribute('hidden');
    graphRoot.setAttribute('hidden', 'true');

    treeRoot.innerHTML = '';
    const tree = document.createElement('ul');
    tree.className = 'visualizer-tree';
    tree.setAttribute('role', 'tree');
    tree.appendChild(buildTreeBranch('JSON', payload, [], 0));
    treeRoot.appendChild(tree);
  }

  function buildTreeBranch(key, value, path, depth) {
    const pathKey = serializePath(path);
    const entries = getChildEntries(value);
    const hasChildren = entries.length > 0;
    rememberPathDepth(pathKey, depth);
    const depthLimited = shouldCollapseByDepth(pathKey, depth);
    const isCollapsed = hasChildren && (collapsedPaths.has(pathKey) || depthLimited);

    const listItem = document.createElement('li');
    listItem.className = 'tree-branch';
    listItem.dataset.depth = String(depth);
    if (hasChildren) {
      listItem.setAttribute('aria-expanded', String(!isCollapsed));
    }
    if (isCollapsed) {
      listItem.classList.add('is-collapsed');
    }

    const control = document.createElement(hasChildren ? 'button' : 'div');
    control.className = `tree-node ${hasChildren ? 'tree-node--branch' : 'tree-node--leaf'}`;
    control.dataset.path = pathKey;
    control.dataset.depth = String(depth);

    if (hasChildren) {
      control.type = 'button';
      control.dataset.action = 'toggle';
      control.setAttribute('aria-expanded', String(!isCollapsed));
    }

    const chevron = document.createElement('span');
    chevron.className = 'tree-node__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    control.appendChild(chevron);

    const keySpan = document.createElement('span');
    const canRename = typeof path[path.length - 1] === 'string';
    keySpan.className = `tree-node__key${canRename ? ' tree-node__key--action' : ''}`;
    keySpan.textContent = String(key);
    if (canRename) {
      keySpan.dataset.action = 'rename';
      keySpan.dataset.path = pathKey;
      keySpan.dataset.key = String(key);
      keySpan.setAttribute('role', 'button');
      keySpan.setAttribute('tabindex', '0');
      keySpan.title = 'Rename key';
    }
    control.appendChild(keySpan);

    const connector = document.createElement('span');
    connector.className = 'tree-node__connector';
    connector.setAttribute('aria-hidden', 'true');
    control.appendChild(connector);

    const descriptor = describeValue(value);
    const valueElement = createValueElement(descriptor, 'tree-node__value', {
      path: pathKey,
      editable: canEditValueDescriptor(descriptor)
    });
    control.appendChild(valueElement);

    listItem.appendChild(control);

    if (hasChildren && !isCollapsed) {
      const childList = document.createElement('ul');
      childList.className = 'visualizer-tree-children';
      childList.setAttribute('role', 'group');
      entries.forEach(([childKey, childValue]) => {
        const childPath = path.concat([childKey]);
        const childLabel = formatChildKey(key, childKey, value);
        childList.appendChild(buildTreeBranch(childLabel, childValue, childPath, depth + 1));
      });
      listItem.appendChild(childList);
    }

    return listItem;
  }

  function renderInvalidState(message) {
    selectionActive = false;
    selectionLabel = '';
    updateSelectionIndicator();
    graphRoot.setAttribute('hidden', 'true');
    treeRoot.setAttribute('hidden', 'true');
    status.textContent = message || 'The document contains syntax errors.';
    status.removeAttribute('hidden');
  }

  function hideStatus() {
    status.setAttribute('hidden', 'true');
  }

  function buildGraph(payload) {
    const nodes = [];
    const edges = [];
    let maxDepth = 0;
    let nextRow = 0;

    const traverse = (key, value, path, depth, parentId) => {
      const pathKey = serializePath(path);
      rememberPathDepth(pathKey, depth);
      const children = getChildEntries(value);
      const hasChildren = children.length > 0;
      const depthLimited = shouldCollapseByDepth(pathKey, depth);
      const isCollapsed = hasChildren && (collapsedPaths.has(pathKey) || depthLimited);

      const lastSegment = path[path.length - 1];
      const node = {
        id: pathKey,
        key: String(key),
        descriptor: describeValue(value),
        depth,
        x: depth * NODE_GAP_X,
        y: 0,
        hasChildren,
        isCollapsed,
        canRename: typeof lastSegment === 'string'
      };

      nodes.push(node);
      maxDepth = Math.max(maxDepth, depth);

      if (parentId) {
        edges.push({ from: parentId, to: pathKey });
      }

      if (!hasChildren || isCollapsed) {
        node.y = nextRow * NODE_GAP_Y;
        nextRow += 1;
        return node.y;
      }

      const childPositions = children.map(([childKey, childValue]) =>
        traverse(formatChildKey(key, childKey, value), childValue, path.concat([childKey]), depth + 1, pathKey)
      );

      if (childPositions.length) {
        const top = childPositions[0];
        const bottom = childPositions[childPositions.length - 1];
        node.y = top + (bottom - top) / 2;
      } else {
        node.y = nextRow * NODE_GAP_Y;
        nextRow += 1;
      }

      return node.y;
    };

    traverse('JSON', payload, [], 0, null);

    const width = (maxDepth + 1) * NODE_GAP_X + CANVAS_PADDING * 2;
    const height = Math.max(nextRow * NODE_GAP_Y, NODE_GAP_Y) + CANVAS_PADDING * 2;

    nodes.forEach((node) => {
      node.x += CANVAS_PADDING;
      node.y += CANVAS_PADDING;
      const custom = nodePositions.get(node.id);
      if (custom) {
        node.x = custom.x;
        node.y = custom.y;
      }
    });

    return {
      nodes,
      edges,
      size: { width, height }
    };
  }

  function createGraphNodeElement(node) {
    const element = document.createElement(node.hasChildren ? 'button' : 'div');
    element.className = `visualizer-node ${node.hasChildren ? 'visualizer-node--branch' : 'visualizer-node--leaf'}`;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    element.dataset.path = node.id;

    if (node.hasChildren) {
      element.type = 'button';
      element.dataset.action = 'toggle';
      element.setAttribute('aria-expanded', String(!node.isCollapsed));
      if (node.isCollapsed) {
        element.classList.add('is-collapsed');
      }
    }

    const chevron = document.createElement('span');
    chevron.className = 'visualizer-node__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    element.appendChild(chevron);

    const key = document.createElement('span');
    key.className = `visualizer-node__key${node.canRename ? ' visualizer-node__key--action' : ''}`;
    key.textContent = node.key;
    if (node.canRename) {
      key.dataset.action = 'rename';
      key.dataset.path = node.id;
      key.dataset.key = node.key;
      key.setAttribute('role', 'button');
      key.setAttribute('tabindex', '0');
      key.title = 'Rename key';
    }
    element.appendChild(key);

    const connector = document.createElement('span');
    connector.className = 'visualizer-node__connector';
    connector.setAttribute('aria-hidden', 'true');
    element.appendChild(connector);

    const valueElement = createValueElement(node.descriptor, 'visualizer-node__value', {
      path: node.id,
      editable: !node.hasChildren && canEditValueDescriptor(node.descriptor)
    });
    element.appendChild(valueElement);

    enableNodeDragging(element, node);

    return element;
  }

  function enableNodeDragging(element, node) {
    element.addEventListener('pointerdown', (event) => {
      if (!shouldStartNodeDrag(event)) {
        return;
      }

      activeNodeDrag = {
        id: node.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: node.x,
        originY: node.y,
        moved: false
      };

      element.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    element.addEventListener('pointermove', (event) => {
      if (!activeNodeDrag || activeNodeDrag.id !== node.id || event.pointerId !== activeNodeDrag.pointerId) {
        return;
      }

      const deltaX = (event.clientX - activeNodeDrag.startX) / panState.scale;
      const deltaY = (event.clientY - activeNodeDrag.startY) / panState.scale;
      const newX = activeNodeDrag.originX + deltaX;
      const newY = activeNodeDrag.originY + deltaY;
      updateNodePosition(node.id, newX, newY);
      activeNodeDrag.moved = true;
      event.preventDefault();
    });

    const endDrag = (event) => finishNodeDrag(event, node, element);
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);

    element.addEventListener('click', (event) => {
      if (element.dataset.dragging === 'true') {
        event.preventDefault();
        event.stopPropagation();
        element.dataset.dragging = '';
      }
    });
  }

  function drawEdges(edges) {
    linksLayer.innerHTML = '';

    edges.forEach((edge) => {
      const parent = nodeElements.get(edge.from);
      const child = nodeElements.get(edge.to);

      if (!parent || !child) {
        return;
      }

      const parentWidth = parent.element.offsetWidth;
      const parentHeight = parent.element.offsetHeight;
      const childHeight = child.element.offsetHeight;

      const startX = parent.node.x + parentWidth;
      const startY = parent.node.y + parentHeight / 2;
      const endX = child.node.x;
      const endY = child.node.y + childHeight / 2;
      const controlOffset = Math.max(32, (endX - startX) / 2);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`
      );
      path.setAttribute('class', 'visualizer-link');
      linksLayer.appendChild(path);
    });
  }

  function updateNodePosition(nodeId, x, y) {
    const entry = nodeElements.get(nodeId);
    if (!entry) {
      return;
    }

    entry.node.x = x;
    entry.node.y = y;
    entry.element.style.left = `${x}px`;
    entry.element.style.top = `${y}px`;
    drawEdges(currentEdges);
  }

  function finishNodeDrag(event, node, element) {
    if (
      !activeNodeDrag ||
      activeNodeDrag.id !== node.id ||
      (event.pointerId !== undefined && event.pointerId !== activeNodeDrag.pointerId)
    ) {
      return;
    }

    try {
      element.releasePointerCapture(activeNodeDrag.pointerId);
    } catch {
      // no-op
    }

    const moved = activeNodeDrag.moved;
    activeNodeDrag = undefined;

    if (moved) {
      element.dataset.dragging = 'true';
      nodePositions.set(node.id, { x: node.x, y: node.y });
      persistState();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function getChildEntries(value) {
    if (Array.isArray(value)) {
      return value.map((child, index) => [index, child]);
    }

    if (isObject(value)) {
      return Object.entries(value);
    }

    return [];
  }

  function describeValue(value) {
    if (value === null) {
      return { label: 'null', kind: 'null', icon: ICON_TYPES.null, rawValue: null };
    }

    if (Array.isArray(value)) {
      return { label: `[${value.length}]`, kind: 'array', icon: ICON_TYPES.array, rawValue: '[array]' };
    }

    switch (typeof value) {
      case 'object':
        return {
          label: `{${Object.keys(value || {}).length}}`,
          kind: 'object',
          icon: ICON_TYPES.object,
          rawValue: '[object]'
        };
      case 'string': {
        const trimmed = value.trim();
        if (isUrl(trimmed)) {
          return {
            label: truncate(trimmed, 42),
            kind: 'link',
            href: trimmed,
            title: trimmed,
            icon: ICON_TYPES.link,
            rawValue: trimmed
          };
        }
        return {
          label: `"${truncate(value)}"`,
          kind: 'string',
          title: value,
          icon: ICON_TYPES.string,
          rawValue: value
        };
      }
      case 'number':
        return { label: String(value), kind: 'number', icon: ICON_TYPES.number, rawValue: value };
      case 'boolean':
        return { label: String(value), kind: 'boolean', icon: ICON_TYPES.boolean, rawValue: value };
      default:
        return { label: '', kind: 'unknown', icon: ICON_TYPES.unknown, rawValue: '' };
    }
  }

  function canEditValueDescriptor(descriptor) {
    if (!descriptor) {
      return false;
    }
    return EDITABLE_VALUE_KINDS.has(descriptor.kind);
  }

  function serializeValueLiteral(rawValue) {
    if (typeof rawValue === 'undefined') {
      return 'null';
    }

    try {
      return JSON.stringify(rawValue);
    } catch {
      return 'null';
    }
  }

  function shouldStartNodeDrag(event) {
    if (event.button !== 0) {
      return false;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return true;
    }

    if (target.closest('[data-action="rename"]')) {
      return false;
    }

    if (target.closest('[data-action="edit-value"]')) {
      return false;
    }

    if (target.closest('[data-open-link="true"]')) {
      return false;
    }

    return true;
  }

  function createValueElement(descriptor, className, options = {}) {
    const element = document.createElement('span');
    element.className = `${className} ${className}--${descriptor.kind}`;
    const icon = createIconElement(descriptor.icon ?? ICON_TYPES.unknown);
    element.appendChild(icon);

    const textSpan = document.createElement('span');
    textSpan.className = `${className}__text`;
    textSpan.textContent = descriptor.label;
    element.appendChild(textSpan);

    if (descriptor.href) {
      element.dataset.openLink = 'true';
      element.setAttribute('data-href', descriptor.href);
      if (descriptor.title) {
        element.title = descriptor.title;
      } else {
        element.title = descriptor.href;
      }
    } else if (descriptor.title) {
      element.title = descriptor.title;
    }

    if (options.editable && options.path) {
      element.dataset.action = 'edit-value';
      element.dataset.path = options.path;
      element.dataset.kind = descriptor.kind === 'link' ? 'string' : descriptor.kind;
      element.dataset.literal = serializeValueLiteral(descriptor.rawValue);
      element.classList.add(`${className}--action`);
      element.setAttribute('role', 'button');
      element.setAttribute('tabindex', '0');
      const baseTitle = element.title;
      const editHint = descriptor.href
        ? 'Click to edit value. Cmd/Ctrl+Click to open link.'
        : 'Click to edit value.';
      element.title = baseTitle ? `${baseTitle}\n${editHint}` : editHint;
    }

    return element;
  }

  function createIconElement(type) {
    const span = document.createElement('span');
    span.className = 'value-icon';
    const markup = ICON_SVGS[type] ?? ICON_SVGS.unknown;
    span.innerHTML = markup;
    const svg = span.querySelector('svg');
    if (svg) {
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
    }
    return span;
  }

  function truncate(value, limit = 28) {
    if (value.length <= limit) {
      return value;
    }

    return `${value.slice(0, limit - 1)}…`;
  }

  function isObject(value) {
    return typeof value === 'object' && value !== null;
  }

  function isUrl(value) {
    return /^https?:\/\/[^\s]+$/i.test(value);
  }

  function serializePath(path) {
    return JSON.stringify(path);
  }

  function computeAutoScale(graphSize, nodeCount) {
    const heuristicScale = clampAutoScale(computeDensityScale(nodeCount));
    const fitScale = computeFitScale(graphSize);
    const candidate = typeof fitScale === 'number' ? Math.min(fitScale, heuristicScale) : heuristicScale;
    return clampAutoScale(Math.max(candidate, AUTO_VISIBLE_MIN_SCALE));
  }

  function computeFitScale(graphSize) {
    if (!graphSize) {
      return undefined;
    }

    const viewportWidth = viewport?.clientWidth || graphRoot.clientWidth || window.innerWidth || 1;
    const viewportHeight = viewport?.clientHeight || graphRoot.clientHeight || window.innerHeight || 1;
    const width = graphSize?.width ?? 0;
    const height = graphSize?.height ?? 0;
    if (width <= 0 || height <= 0) {
      return undefined;
    }

    const ratio = Math.min(viewportWidth / width, viewportHeight / height);
    const padded = ratio * AUTO_FIT_PADDING;
    if (!Number.isFinite(padded) || padded <= 0) {
      return undefined;
    }

    return padded;
  }

  function computeDensityScale(nodeCount) {
    if (nodeCount > 2000) {
      return 0.35;
    }
    if (nodeCount > 1200) {
      return 0.45;
    }
    if (nodeCount > 800) {
      return 0.55;
    }
    if (nodeCount > 500) {
      return 0.65;
    }
    if (nodeCount > 300) {
      return 0.8;
    }
    return 1;
  }

  function clampAutoScale(value) {
    const candidate = typeof value === 'number' && Number.isFinite(value) ? value : 1;
    return clamp(candidate, AUTO_MIN_SCALE, AUTO_MAX_SCALE);
  }

  function clampScale(value) {
    const candidate = typeof value === 'number' ? value : 1;
    return clamp(candidate, MANUAL_MIN_SCALE, AUTO_MAX_SCALE);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function formatChildKey(parentLabel, childKey, parentValue) {
    if (!Array.isArray(parentValue)) {
      return String(childKey);
    }

    const baseLabel = deriveArrayItemLabel(parentLabel);
    const numeric = Number(childKey);
    const suffix = Number.isInteger(numeric) ? numeric + 1 : String(childKey);
    return `${baseLabel} ${suffix}`;
  }

  function deriveArrayItemLabel(parentLabel) {
    if (!parentLabel || parentLabel === 'JSON') {
      return 'Item';
    }

    const trimmed = parentLabel.trim();
    if (!trimmed) {
      return 'Item';
    }

    const lower = trimmed.toLowerCase();
    if (lower.endsWith('ies')) {
      return capitalize(lower.slice(0, -3) + 'y');
    }

    if (lower.endsWith('ses')) {
      return capitalize(lower.slice(0, -2));
    }

    if (lower.endsWith('s')) {
      return capitalize(lower.slice(0, -1));
    }

    return capitalize(lower);
  }

  function parseLineInput(value) {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  }

  function normalizeLineRange(start, end) {
    if (start > end) {
      return { start: end, end: start };
    }
    return { start, end };
  }

  function formatSelectionLabel(start, end) {
    if (start === end) {
      return `Line ${start}`;
    }
    return `Lines ${start}-${end}`;
  }

  function capitalize(value) {
    if (!value) {
      return '';
    }

    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function formatProviderName(provider) {
    switch (provider) {
      case 'openai':
        return 'OpenAI';
      case 'anthropic':
        return 'Anthropic';
      default:
        return capitalize(provider);
    }
  }

  function getMissingKeyMessage() {
    return `Set your ${formatProviderName(activeModelProvider)} API key to send messages.`;
  }

  function serializePositions(map) {
    const result = {};
    map.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  function updateSearchIndex(nodes) {
    searchIndex = new Map();
    nodes.forEach((node) => {
      const descriptorLabel = typeof node.descriptor?.label === 'string' ? node.descriptor.label : '';
      const rawValue =
        typeof node.descriptor?.rawValue === 'string'
          ? node.descriptor.rawValue
          : typeof node.descriptor?.rawValue !== 'undefined'
            ? String(node.descriptor.rawValue)
            : '';
      const text = [node.key, descriptorLabel, rawValue].filter(Boolean).join(' ').toLowerCase();
      searchIndex.set(node.id, { text });
    });

    if (currentSearchQuery) {
      if (!searchIndex.has(currentSearchMatch ?? '')) {
        currentSearchMatch = undefined;
      }
    }
  }

  function performSearch(query) {
    currentSearchQuery = query;
    if (!query) {
      pendingSearchFocusId = undefined;
      currentSearchMatch = undefined;
      clearSearchHighlight();
      return;
    }

    const normalized = query.toLowerCase();
    let matchId;
    for (const [id, payload] of searchIndex) {
      if (payload.text.includes(normalized)) {
        matchId = id;
        break;
      }
    }

    if (!matchId) {
      clearSearchHighlight();
      currentSearchMatch = undefined;
      return;
    }

    currentSearchMatch = matchId;
    pendingSearchFocusId = matchId;

    if (viewMode !== 'graph') {
      setViewMode('graph');
      return;
    }

    focusGraphNode(matchId);
  }

  function clearSearchHighlight() {
    nodeElements.forEach(({ element }) => element.classList.remove('is-search-hit'));
    treeRoot.querySelectorAll('.tree-node.is-search-hit').forEach((node) => node.classList.remove('is-search-hit'));
  }

  function applySearchHighlight() {
    clearSearchHighlight();
    if (!currentSearchQuery || viewMode !== 'graph') {
      return;
    }

    if (currentSearchMatch && nodeElements.has(currentSearchMatch)) {
      nodeElements.get(currentSearchMatch).element.classList.add('is-search-hit');
    }
  }

  function focusGraphNode(nodeId) {
    const entry = nodeElements.get(nodeId);
    if (!entry) {
      return;
    }

    nodeElements.forEach(({ element }) => element.classList.remove('is-search-hit'));
    entry.element.classList.add('is-search-hit');

    const viewportWidth = viewport?.clientWidth ?? 0;
    const viewportHeight = viewport?.clientHeight ?? 0;
    const nodeWidth = entry.element.offsetWidth || 0;
    const nodeHeight = entry.element.offsetHeight || 0;
    const scale = panState.scale || 1;

    panState.x = viewportWidth / 2 - (entry.node.x + nodeWidth / 2) * scale;
    panState.y = viewportHeight / 2 - (entry.node.y + nodeHeight / 2) * scale;
    applyPan();
    pendingSearchFocusId = undefined;
  }

  function focusTreeNode(path) {
    if (!path) {
      return;
    }
    requestAnimationFrame(() => {
      const selector = `.tree-node[data-path="${escapeCss(path)}"]`;
      const node = treeRoot.querySelector(selector);
      if (!(node instanceof HTMLElement)) {
        return;
      }
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node.classList.add('is-search-hit');
      if (typeof node.focus === 'function') {
        node.focus({ preventScroll: true });
      }
      setTimeout(() => node.classList.remove('is-search-hit'), 800);
    });
  }

  function focusPath(path) {
    if (!path) {
      return;
    }
    if (viewMode === 'graph') {
      requestAnimationFrame(() => focusGraphNode(path));
    } else {
      focusTreeNode(path);
    }
  }

  function setControlsCollapsed(value, options = { persist: true }) {
    controlsCollapsed = Boolean(value);
    if (controlDock instanceof HTMLElement) {
      controlDock.classList.toggle('is-collapsed', controlsCollapsed);
    }
    if (controlDockPanel instanceof HTMLElement) {
      controlDockPanel.setAttribute('aria-hidden', String(controlsCollapsed));
    }
    if (controlDockToggle instanceof HTMLButtonElement) {
      controlDockToggle.setAttribute('aria-expanded', String(!controlsCollapsed));
      controlDockToggle.title = controlsCollapsed ? 'Show controls' : 'Hide controls';
      controlDockToggle.setAttribute('aria-label', controlsCollapsed ? 'Show controls' : 'Hide controls');
    }
    if (options.persist !== false) {
      persistState();
    }
  }

  function toggleChatPanel(forceState) {
    if (!(chatPanel instanceof HTMLElement)) {
      return;
    }

    const nextState = typeof forceState === 'boolean' ? forceState : !chatPanelVisible;
    chatPanelVisible = nextState;
    if (nextState) {
      chatPanel.removeAttribute('hidden');
      if (chatInput instanceof HTMLTextAreaElement) {
        chatInput.focus();
      }
    } else {
      chatPanel.setAttribute('hidden', 'true');
    }
  }

  function applySelectionInfo(info) {
    if (info && typeof info === 'object') {
      selectionActive = Boolean(info.active);
      const startLine = typeof info.startLine === 'number' ? info.startLine + 1 : undefined;
      const endLine = typeof info.endLine === 'number' ? info.endLine + 1 : undefined;
      const hasRange = typeof startLine === 'number' && typeof endLine === 'number';
      selectionLineRange = selectionActive && hasRange ? { start: startLine, end: endLine } : {};
    } else {
      selectionActive = false;
      selectionLineRange = {};
    }
    updateSelectionIndicator();
  }

  function updateSelectionIndicator() {
    updateSelectionInputs();
  }

  function updateSelectionInputs() {
    if (!(selectionStartInput instanceof HTMLInputElement) || !(selectionEndInput instanceof HTMLInputElement)) {
      return;
    }

    if (typeof selectionLineRange.start === 'number') {
      selectionStartInput.value = String(selectionLineRange.start);
    } else if (!selectionStartInput.matches(':focus')) {
      selectionStartInput.value = '';
    }

    if (typeof selectionLineRange.end === 'number') {
      selectionEndInput.value = String(selectionLineRange.end);
    } else if (!selectionEndInput.matches(':focus')) {
      selectionEndInput.value = '';
    }
  }

  function updateModelSelect(payload) {
    if (!(chatModelSelect instanceof HTMLSelectElement)) {
      return;
    }

    const options = Array.isArray(payload?.options) ? payload.options : [];
    const selectedId = typeof payload?.selectedId === 'string' ? payload.selectedId : '';
    if (typeof payload?.selectedProvider === 'string') {
      activeModelProvider = payload.selectedProvider;
    }
    chatModelSelect.innerHTML = '';

    if (!options.length) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'No models';
      chatModelSelect.appendChild(placeholder);
      chatModelSelect.disabled = true;
      return;
    }

    options.forEach((option) => {
      if (!option || typeof option !== 'object') {
        return;
      }
      const element = document.createElement('option');
      element.value = String(option.id ?? '');
      element.textContent = option.label ?? option.id ?? 'Model';
      if (option.description) {
        element.title = option.description;
      }
      chatModelSelect.appendChild(element);
    });

    chatModelSelect.disabled = false;
    if (selectedId) {
      chatModelSelect.value = selectedId;
    }
  }

  function ensureChatPanel() {
    if (!chatPanelVisible) {
      toggleChatPanel(true);
    }
  }

  function clearChatMessages() {
    chatMessageMap.clear();
    if (chatMessages) {
      chatMessages.innerHTML = '';
    }
  }

  function renderChatHistory(messages) {
    clearChatMessages();
    if (!Array.isArray(messages)) {
      return;
    }

    messages.forEach((entry) => setChatMessage(entry?.id, entry?.role ?? 'assistant', entry?.text ?? ''));
  }

  function setChatMessage(id, role, text, options = {}) {
    if (!id) {
      return;
    }
    const record = getOrCreateChatRecord(id, role);
    record.text = options.pending ? '' : text;
    record.element.classList.toggle('is-pending', Boolean(options.pending));
    record.content.innerHTML = renderChatHtml(record.text, options.pending);
    scrollChatToBottom();
    showChatStatus('');
  }

  function appendChatDelta(id, delta) {
    if (!id || !delta) {
      return;
    }
    const record = getOrCreateChatRecord(id, 'assistant');
    record.element.classList.remove('is-pending');
    const isThinkingPlaceholder =
      typeof record.text === 'string' && record.text.trim().startsWith('AI is thinking');
    const current = isThinkingPlaceholder ? '' : record.text || '';
    record.text = current + delta;
    record.content.innerHTML = renderChatHtml(record.text);
    scrollChatToBottom();
    showChatStatus('');
  }

  function finalizeAssistantMessage(id, text, snippet) {
    if (!id) {
      return;
    }
    const record = getOrCreateChatRecord(id, 'assistant');
    record.text = text;
    record.element.classList.remove('is-pending');
    record.content.innerHTML = renderChatHtml(text);

    const existing = record.element.querySelector('.chat-message__actions');
    if (existing) {
      existing.remove();
    }

    if (snippet) {
      const actions = document.createElement('div');
      actions.className = 'chat-message__actions';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Apply snippet';
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'chat:applySnippet', payload: { content: snippet } });
      });
      actions.appendChild(button);
      record.element.appendChild(actions);
    }

    scrollChatToBottom();
  }

  function getOrCreateChatRecord(id, role) {
    let record = chatMessageMap.get(id);
    if (!record) {
      const wrapper = document.createElement('div');
      wrapper.className = `chat-message chat-message--${role}`;
      const content = document.createElement('div');
      content.className = 'chat-message__content';
      wrapper.appendChild(content);
      chatMessages?.appendChild(wrapper);
      record = { element: wrapper, content, text: '' };
      chatMessageMap.set(id, record);
    }
    return record;
  }

  function scrollChatToBottom() {
    if (!chatMessages) {
      return;
    }
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  function showChatStatus(text) {
    if (!(chatStatus instanceof HTMLElement)) {
      return;
    }

    const normalized = typeof text === 'string' ? text.trim() : '';
    const isThinking =
      normalized === 'Thinking…' ||
      normalized === 'Thinking...' ||
      normalized === 'AI is thinking…' ||
      normalized === 'AI is thinking...';

    if (isThinking) {
      chatStatus.innerHTML =
        'AI is thinking<span class="chat-status__dots"><span>.</span><span>.</span><span>.</span></span>';
      chatStatus.classList.add('is-thinking');
      return;
    }

    chatStatus.textContent = text || '';
    chatStatus.classList.remove('is-thinking');
  }

  function renderChatHtml(text, pending) {
    if (pending) {
      return `<span class="chat-pending-dots"><span></span><span></span><span></span></span>`;
    }

    const escape = (value) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const codeRegex = /```(\w+)?\s*([\s\S]*?)```/g;
    let lastIndex = 0;
    let html = '';
    let match;
    while ((match = codeRegex.exec(text)) !== null) {
      html += escape(text.slice(lastIndex, match.index));
      const lang = match[1]?.trim() ?? 'json';
      const code = escape(match[2].trim());
      html += `<pre class="chat-code"><code class="lang-${lang}">${code}</code></pre>`;
      lastIndex = codeRegex.lastIndex;
    }
    html += escape(text.slice(lastIndex));
    return html;
  }

  function escapeCss(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

})();
