const state = {
  granularity: 'current_week',
};

const els = {
  startDate: document.querySelector('#startDate'),
  endDate: document.querySelector('#endDate'),
  runButton: document.querySelector('#runButton'),
  statusStrip: document.querySelector('#statusStrip'),
  netSales: document.querySelector('#netSales'),
  unitsSold: document.querySelector('#unitsSold'),
  asp: document.querySelector('#asp'),
  inventoryUnits: document.querySelector('#inventoryUnits'),
  generatedAt: document.querySelector('#generatedAt'),
  resultsBody: document.querySelector('#resultsBody'),
  segments: [...document.querySelectorAll('.segment')],
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

  els.runButton.addEventListener('click', () => loadAsp());
  loadAsp();
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

  els.netSales.textContent = currency(summary.netSales);
  els.unitsSold.textContent = wholeNumber(summary.unitsSold);
  els.asp.textContent = currency(summary.asp);
  els.inventoryUnits.textContent = wholeNumber(summary.inventoryUnits);
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
  els.statusStrip.innerHTML = chips.join('');
}

function renderRows(rows) {
  if (!rows.length) {
    els.resultsBody.innerHTML = `<tr><td class="empty" colspan="6">No rows returned.</td></tr>`;
    return;
  }

  els.resultsBody.innerHTML = rows
    .map((row) => {
      return `
        <tr>
          <td>${escapeHtml(row.label)}</td>
          <td>${currency(row.netSales)}</td>
          <td>${wholeNumber(row.unitsSold)}</td>
          <td>${wholeNumber(row.orders)}</td>
          <td>${currency(row.asp)}</td>
          <td>${wholeNumber(row.inventoryUnits)}</td>
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

function currentWeekRange() {
  const today = new Date();
  const dayIndex = (today.getDay() + 6) % 7;
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
