const state = {
  granularity: 'current_week',
  view: 'calculator',
  mappings: [],
  mappingMeta: {},
};

const els = {
  startDate: document.querySelector('#startDate'),
  endDate: document.querySelector('#endDate'),
  runButton: document.querySelector('#runButton'),
  statusStrip: document.querySelector('#statusStrip'),
  netSales: document.querySelector('#netSales'),
  unitsSold: document.querySelector('#unitsSold'),
  asp: document.querySelector('#asp'),
  mappedRows: document.querySelector('#mappedRows'),
  generatedAt: document.querySelector('#generatedAt'),
  resultsBody: document.querySelector('#resultsBody'),
  segments: [...document.querySelectorAll('.segment')],
  viewTabs: [...document.querySelectorAll('.view-tab')],
  calculatorView: document.querySelector('#calculatorView'),
  mappingView: document.querySelector('#mappingView'),
  mappingBody: document.querySelector('#mappingBody'),
  mappingStatus: document.querySelector('#mappingStatus'),
  addMappingButton: document.querySelector('#addMappingButton'),
  saveMappingButton: document.querySelector('#saveMappingButton'),
};

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

initialize();

function initialize() {
  const { start, end } = currentWeekRange();
  els.startDate.value = start;
  els.endDate.value = end;

  els.segments.forEach((button) => {
    button.addEventListener('click', () => setGranularity(button.dataset.granularity));
  });

  els.viewTabs.forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });

  els.runButton.addEventListener('click', () => loadAsp());
  els.addMappingButton.addEventListener('click', () => addMappingRow());
  els.saveMappingButton.addEventListener('click', () => saveMappings());
  els.mappingBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-mapping]');
    if (!button) return;
    button.closest('tr')?.remove();
    setMappingStatus('Unsaved changes');
  });
  els.mappingBody.addEventListener('input', () => setMappingStatus('Unsaved changes'));
  els.mappingBody.addEventListener('change', () => setMappingStatus('Unsaved changes'));

  loadMappings();
  loadAsp();
}

function setView(view) {
  state.view = view;
  const isMapping = view === 'mapping';
  els.calculatorView.classList.toggle('active', !isMapping);
  els.mappingView.classList.toggle('active', isMapping);

  els.viewTabs.forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setGranularity(granularity) {
  state.granularity = granularity;

  if (granularity === 'current_week') {
    const { start, end } = currentWeekRange();
    els.startDate.value = start;
    els.endDate.value = end;
  }

  els.segments.forEach((button) => {
    const active = button.dataset.granularity === granularity;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function loadMappings() {
  setMappingStatus('Loading...');

  try {
    const response = await fetch('/api/mappings');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || 'Mapping request failed');

    state.mappingMeta = payload;
    state.mappings = payload.mappings || [];
    renderMappingRows(state.mappings);
    setMappingStatus(`${payload.summary?.active || 0} active`);
  } catch (error) {
    setMappingStatus(error.message);
  }
}

async function saveMappings() {
  const mappings = collectMappingRows();
  els.saveMappingButton.disabled = true;
  setMappingStatus('Saving...');

  try {
    const response = await fetch('/api/mappings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: state.mappingMeta.version || 1,
        sourceFiles: state.mappingMeta.sourceFiles || [],
        mappings,
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || 'Mapping save failed');

    state.mappingMeta = payload;
    state.mappings = payload.mappings || [];
    renderMappingRows(state.mappings);
    setMappingStatus(`${payload.summary?.active || 0} active`);
    await loadAsp();
  } catch (error) {
    setMappingStatus(error.message);
  } finally {
    els.saveMappingButton.disabled = false;
  }
}

function renderMappingRows(mappings) {
  if (!mappings.length) {
    els.mappingBody.innerHTML = `<tr><td class="empty" colspan="8">No mappings yet.</td></tr>`;
    return;
  }

  els.mappingBody.innerHTML = mappings.map((mapping) => mappingRowTemplate(mapping)).join('');
}

function addMappingRow() {
  if (els.mappingBody.querySelector('.empty')) {
    els.mappingBody.innerHTML = '';
  }

  els.mappingBody.insertAdjacentHTML('beforeend', mappingRowTemplate({
    id: `map-${Date.now()}`,
    active: true,
    shopifySku: '',
    shopifyTitle: '',
    netsuiteItem: '',
    netsuiteName: '',
    candleUnitsPerNetSuiteUnit: 1,
    notes: '',
  }));
  setMappingStatus('Unsaved changes');
}

function mappingRowTemplate(mapping) {
  return `
    <tr data-mapping-id="${escapeHtml(mapping.id || '')}">
      <td>
        <input class="mapping-check" type="checkbox" data-field="active" ${mapping.active ? 'checked' : ''} aria-label="Include in ASP">
      </td>
      <td><input class="mapping-input code" data-field="shopifySku" value="${escapeHtml(mapping.shopifySku || '')}"></td>
      <td><input class="mapping-input title" data-field="shopifyTitle" value="${escapeHtml(mapping.shopifyTitle || '')}"></td>
      <td><input class="mapping-input code" data-field="netsuiteItem" value="${escapeHtml(mapping.netsuiteItem || '')}"></td>
      <td><input class="mapping-input title" data-field="netsuiteName" value="${escapeHtml(mapping.netsuiteName || '')}"></td>
      <td><input class="mapping-input factor" type="number" min="0" step="0.01" data-field="candleUnitsPerNetSuiteUnit" value="${numberInput(mapping.candleUnitsPerNetSuiteUnit ?? 1)}"></td>
      <td><input class="mapping-input note" data-field="notes" value="${escapeHtml(mapping.notes || '')}"></td>
      <td><button class="icon-button" type="button" data-remove-mapping aria-label="Remove row">x</button></td>
    </tr>
  `;
}

function collectMappingRows() {
  return [...els.mappingBody.querySelectorAll('tr[data-mapping-id]')].map((row, index) => {
    const value = (field) => row.querySelector(`[data-field="${field}"]`);
    return {
      id: row.dataset.mappingId || `map-${index + 1}`,
      active: Boolean(value('active')?.checked),
      shopifySku: value('shopifySku')?.value || '',
      shopifyTitle: value('shopifyTitle')?.value || '',
      netsuiteItem: value('netsuiteItem')?.value || '',
      netsuiteName: value('netsuiteName')?.value || '',
      candleUnitsPerNetSuiteUnit: Number(value('candleUnitsPerNetSuiteUnit')?.value || 1),
      notes: value('notes')?.value || '',
    };
  });
}

function setMappingStatus(message) {
  els.mappingStatus.textContent = message;
}

async function loadAsp() {
  setLoading(true);
  renderError('');

  try {
    const response = await fetch('/api/asp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate: els.startDate.value,
        endDate: els.endDate.value,
        granularity: state.granularity,
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || 'ASP request failed');

    render(payload);
  } catch (error) {
    renderError(error.message);
  } finally {
    setLoading(false);
  }
}

function render(payload) {
  const summary = payload.summary || {};
  const mappedRowCount = Number(summary.mappedShopifyRows || 0) + Number(summary.mappedNetSuiteRows || 0);

  els.netSales.textContent = currency(summary.netSales);
  els.unitsSold.textContent = decimalNumber(summary.unitsSold);
  els.asp.textContent = currency(summary.asp);
  els.mappedRows.textContent = wholeNumber(mappedRowCount);
  els.generatedAt.textContent = payload.generatedAt
    ? `Updated ${new Date(payload.generatedAt).toLocaleString()}`
    : '';

  renderStatus(payload);
  renderRows(payload.rows || []);
}

function renderStatus(payload) {
  const chips = [];
  chips.push(chip(payload.dataMode === 'live' ? 'Live data' : 'Demo data', payload.dataMode === 'live' ? 'live' : 'demo'));
  chips.push(chip(payload.config?.shopify?.configured ? 'Shopify set' : 'Shopify pending'));
  chips.push(chip(payload.config?.netsuite?.configured ? 'NetSuite set' : 'NetSuite pending'));
  if (payload.mappings) chips.push(chip(`${payload.mappings.active || 0} mappings`, 'live'));
  els.statusStrip.innerHTML = chips.join('');
}

function renderRows(rows) {
  if (!rows.length) {
    els.resultsBody.innerHTML = `<tr><td class="empty" colspan="6">No rows returned.</td></tr>`;
    return;
  }

  els.resultsBody.innerHTML = rows
    .map((row) => {
      const mappedRows = Number(row.mappedShopifyRows || 0) + Number(row.mappedNetSuiteRows || 0);
      return `
        <tr>
          <td>${escapeHtml(row.label)}</td>
          <td>${currency(row.netSales)}</td>
          <td>${decimalNumber(row.unitsSold)}</td>
          <td>${wholeNumber(row.orders)}</td>
          <td>${currency(row.asp)}</td>
          <td>${wholeNumber(mappedRows)}</td>
        </tr>
      `;
    })
    .join('');
}

function renderError(message) {
  if (!message) return;

  els.resultsBody.innerHTML = `<tr><td class="error" colspan="6">${escapeHtml(message)}</td></tr>`;
  els.statusStrip.innerHTML = chip('Needs attention', 'demo');
}

function setLoading(isLoading) {
  els.runButton.disabled = isLoading;
  els.runButton.textContent = isLoading ? 'Running...' : 'Run ASP';
}

function chip(label, tone = '') {
  return `<span class="chip ${tone}">${escapeHtml(label)}</span>`;
}

function currency(value) {
  return currencyFormatter.format(Number(value || 0));
}

function wholeNumber(value) {
  return numberFormatter.format(Number(value || 0));
}

function decimalNumber(value) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: Number(value || 0) % 1 === 0 ? 0 : 2,
  }).format(Number(value || 0));
}

function numberInput(value) {
  const number = Number(value ?? 1);
  return Number.isFinite(number) ? String(number) : '1';
}

function currentWeekRange() {
  const today = new Date();
  const dayIndex = today.getDay();
  const start = new Date(today);
  start.setDate(today.getDate() - dayIndex);

  return {
    start: isoDate(start),
    end: isoDate(today),
  };
}

function isoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
