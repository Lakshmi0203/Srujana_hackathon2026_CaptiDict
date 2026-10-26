(function () {
  "use strict";

 var STORAGE_KEY = "captidict-demo-v1";
var DEMO_STORAGE_KEY = STORAGE_KEY;

function getAccountStorageKey() {
  var token = sessionStorage.getItem("srujana-token");
  return token ? STORAGE_KEY + "-" + token.slice(-16) : STORAGE_KEY;
}
  var ANCHOR = new Date(2026, 9, 24);
  var RESERVE = 150000;
  var forecastHorizonDays = 30;
  var initialState = {
    openingCash: 0,
    reserveLimit: 150000,
    transactions: [],
    scenario: { delayDays: 0, extraExpense: 0, extraExpenseDate: "2026-11-06", salesDrop: 0, supplierShiftDays: 0, paymentShifts: {}, receiptDelays: {}, whatIfApplied: false },
    completedActions: []
  };

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function loadState() {
    try {
      var saved = localStorage.getItem(getAccountStorageKey());
      if (!saved) return copy(initialState);
      var parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.transactions) || !parsed.scenario) return copy(initialState);
      if (!Array.isArray(parsed.completedActions)) parsed.completedActions = [];
      if (!Number.isFinite(Number(parsed.reserveLimit)) || Number(parsed.reserveLimit) < 0) parsed.reserveLimit = 150000;
      if (!parsed.scenario.extraExpenseDate) parsed.scenario.extraExpenseDate = "2026-11-06";
      if (!parsed.scenario.paymentShifts || typeof parsed.scenario.paymentShifts !== "object") parsed.scenario.paymentShifts = {};
      if (!parsed.scenario.receiptDelays || typeof parsed.scenario.receiptDelays !== "object") parsed.scenario.receiptDelays = {};
      if (typeof parsed.scenario.whatIfApplied !== "boolean") parsed.scenario.whatIfApplied = false;
      parsed.transactions.forEach(function (transaction) {
        if (transaction.type === "outflow") {
          var sampleDelayCosts = { supplier: 8500, rent: 7500, payroll: 18000, loan: 4500 };
          if (transaction.delayCostPerWeek === undefined) transaction.delayCostPerWeek = sampleDelayCosts[transaction.id] === undefined ? null : sampleDelayCosts[transaction.id];
          if (typeof transaction.canDefer !== "boolean") transaction.canDefer = transaction.id === "supplier";
        }
      });
      return parsed;
    } catch (error) {
      return copy(initialState);
    }
  }

  var state = loadState();

  // Keep dashboard summary values inside their rows on narrower screens.
  (function fixDashboardOverflow() {
    var style = document.createElement("style");
    style.id = "captidict-dashboard-layout-fix";
    style.textContent = `
      .summary-grid { grid-template-columns: minmax(0, 1fr); }
      .summary-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px; }
      .summary-row span { min-width: 0; overflow-wrap: anywhere; }
      .summary-row strong { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: right; font-variant-numeric: tabular-nums; }
      .health-row, .glance-row, .health-item, .insight-row, .cash-health-row,
      #health-title, #health-subtitle, #health-receipts, #health-payments { min-width: 0; }
      .health-row > *, .glance-row > *, .health-item > *, .insight-row > *, .cash-health-row > *,
      #health-title, #health-subtitle, #health-receipts, #health-payments { overflow-wrap: anywhere; }
      .health-row, .glance-row, .health-item, .insight-row, .cash-health-row {
        box-sizing: border-box; max-width: 100%;
      }
      .health-row strong, .glance-row strong, .health-item strong, .insight-row strong,
      .cash-health-row strong, .health-row [data-value], .glance-row [data-value] {
        min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere;
        text-align: right; font-variant-numeric: tabular-nums;
      }
      .summary-row { box-sizing: border-box; width: 100%; }
      .summary-row > :last-child { justify-self: end; }
      .summary-row > :first-child { min-width: 0; }
      @media (max-width: 900px) {
        .summary-grid { grid-template-columns: minmax(0, 1fr); }
        .summary-row strong { max-width: 48%; }
      }
    `;
    document.head.appendChild(style);
  })();

  RESERVE = Number(state.reserveLimit);
  var toastTimer;
  var pendingImportRows = [];
  var pendingWhatIf = null;
  var selectedChaseId = "";
  var selectedChaseTone = "friendly";
  var chaseDraftEdited = false;
  var activeTransactionTab = "all";
  var backtestResult = null;

  function saveState() {
    try {
      localStorage.setItem(getAccountStorageKey(), JSON.stringify(state));
      return true;
    } catch (error) {
      return false;
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  
  // Authenticated transaction API. Transactions are stored in PostgreSQL, not only in browser storage.
  function transactionApi(path, options) {
    var token = sessionStorage.getItem("srujana-token");
    if (!token) return Promise.reject(new Error("Your session has expired. Please sign in again."));
    var requestOptions = Object.assign({}, options || {});
    requestOptions.headers = Object.assign({}, requestOptions.headers || {}, { "Authorization": "Bearer " + token });
    if (requestOptions.body && !requestOptions.headers["Content-Type"]) requestOptions.headers["Content-Type"] = "application/json";
    return fetch("http://localhost:4000/api/transactions" + (path || ""), requestOptions).then(async function (response) {
      if (response.status === 204) return null;
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        var error = result.error || result;
        throw new Error(error.message || "Transaction request failed (" + response.status + ").");
      }
      return result;
    });
  }

  function normalizeTransaction(item) {
    return {
      id: item.id,
      title: item.title,
      type: item.type,
      amount: Number(item.amount) || 0,
      date: item.date,
      confidence: item.confidence == null ? 1 : Number(item.confidence),
      status: item.status || "forecast",
      key: item.key || "custom",
      delayCostPerWeek: item.delayCostPerWeek == null ? null : Number(item.delayCostPerWeek),
      canDefer: Boolean(item.canDefer),
      companyName: item.companyName || "", feedbackOutcome: item.feedbackOutcome || null, confidenceSource: item.confidenceSource || "legacy"
    };
  }

  async function loadTransactionsFromServer() {
    var result = await transactionApi("?limit=100");
    state.transactions = (result && Array.isArray(result.data) ? result.data : []).map(normalizeTransaction);
    // Clear scenario adjustments that refer to transactions no longer present.
    var ids = new Set(state.transactions.map(function (item) { return item.id; }));
    Object.keys(state.scenario.paymentShifts || {}).forEach(function (id) { if (!ids.has(id)) delete state.scenario.paymentShifts[id]; });
    Object.keys(state.scenario.receiptDelays || {}).forEach(function (id) { if (!ids.has(id)) delete state.scenario.receiptDelays[id]; });
    saveState();
  }

  async function updateTransactionOnServer(id, changes) {
    var result = await transactionApi("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(changes) });
    return result && result.data ? normalizeTransaction(result.data) : null;
  }

  async function deleteTransaction(id) {
    var transaction = state.transactions.find(function (item) { return String(item.id) === String(id); });
    if (!transaction) return;
    var label = transaction.title || "this transaction";
    if (!window.confirm('Delete "' + label + '"? This cannot be undone.')) return;

    var deleteButtons = document.querySelectorAll('[data-transaction-delete="' + CSS.escape(String(id)) + '"]');
    deleteButtons.forEach(function (button) { button.disabled = true; });

    try {
      await transactionApi("/" + encodeURIComponent(id), { method: "DELETE" });
      state.transactions = state.transactions.filter(function (item) { return String(item.id) !== String(id); });
      delete state.scenario.paymentShifts[id];
      delete state.scenario.receiptDelays[id];
      saveState();
      render();
      showToast("Transaction deleted");
    } catch (error) {
      deleteButtons.forEach(function (button) { button.disabled = false; });
      showToast(error.message || "Could not delete transaction. Please try again.");
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function money(value) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Math.round(value));
  }

  function shortMoney(value) {
    var absolute = Math.abs(value);
    var sign = value < 0 ? "−" : "";
    if (absolute >= 100000) return sign + "₹" + (absolute / 100000).toFixed(absolute % 100000 === 0 ? 0 : 1) + "L";
    if (absolute >= 1000) return sign + "₹" + (absolute / 1000).toFixed(absolute % 1000 === 0 ? 0 : 1) + "k";
    return sign + "₹" + Math.round(absolute);
  }

  function toISO(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }

  // Display the browser's current system date, refreshing automatically each minute.
  function updateCurrentSystemDate() {
    var now = new Date();
    var headingDate = byId("current-system-date");
    var cashAsOfDate = byId("cash-as-of-date");

    if (headingDate) {
      headingDate.textContent = new Intl.DateTimeFormat("en-IN", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric"
      }).format(now).toUpperCase();
    }

    if (cashAsOfDate) {
      cashAsOfDate.textContent = new Intl.DateTimeFormat("en-IN", {
        day: "numeric",
        month: "short"
      }).format(now);
    }
  }

  updateCurrentSystemDate();
  setInterval(updateCurrentSystemDate, 60 * 1000);

  function fromISO(value) {
    var parts = value.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function shiftISO(value, days) {
    var date = fromISO(value);
    date.setDate(date.getDate() + days);
    return toISO(date);
  }

  function daysFromAnchor(value) {
    var date = fromISO(value);
    return Math.round((date.getTime() - ANCHOR.getTime()) / 86400000);
  }

  function receiptConfidence(transaction) {
    if (transaction.confidence === undefined || transaction.confidence === null || transaction.confidence === "") return 1;
    var value = Number(transaction.confidence);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  }

  function receiptDelayDays(transaction, options, largestPendingReceipt) {
    var namedDelay = options && options.receiptDelays ? Number(options.receiptDelays[transaction.id]) : 0;
    if (Number.isFinite(namedDelay) && namedDelay > 0) return namedDelay;
    return options && largestPendingReceipt && transaction.id === largestPendingReceipt.id ? Number(options.delayDays) || 0 : 0;
  }

  function formatDate(value, withYear) {
    return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: withYear ? "numeric" : undefined }).format(fromISO(value));
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function projectedTransactions(options) {
    var result = [];
    var largestPendingReceipt = state.transactions.filter(function (item) { return item.type === "inflow" && item.status === "forecast"; }).sort(function (a, b) { return Number(b.amount) - Number(a.amount); })[0];
    state.transactions.forEach(function (transaction) {
      if (transaction.status !== "forecast") return;
      var amount = Number(transaction.amount) || 0;
      var date = transaction.date;
      var confidence = receiptConfidence(transaction);
      if (transaction.type === "inflow") date = shiftISO(date, receiptDelayDays(transaction, options, largestPendingReceipt));
      if (options && transaction.key === "supplier") date = shiftISO(date, options.supplierShiftDays || 0);
      if (options && options.paymentShifts && options.paymentShifts[transaction.id]) date = shiftISO(date, Number(options.paymentShifts[transaction.id]) || 0);
      if (options && transaction.type === "inflow" && (transaction.key === "sales" || /sales/i.test(transaction.title)) && options.salesDrop) amount = amount * (1 - options.salesDrop / 100);
      if (transaction.type === "inflow") amount = amount * confidence;
      result.push({ id: transaction.id, date: date, amount: transaction.type === "inflow" ? amount : -amount, title: transaction.title, key: transaction.key });
    });
    if (options && options.extraExpense > 0) {
      result.push({ date: options.extraExpenseDate || "2026-11-06", amount: -Number(options.extraExpense), title: "Unexpected expense", key: "surprise" });
    }
    return result;
  }

  function makeSeries(options, horizonDays) {
    var days = Math.max(1, Number(horizonDays) || forecastHorizonDays || 30);
    var daily = Array.from({ length: days + 1 }, function (_, day) { return { day: day, balance: day === 0 ? (Number(state.openingCash) || 0) : 0 }; });
    var events = projectedTransactions(options);
    events.forEach(function (event) {
      var day = daysFromAnchor(event.date);
      if (day >= 0 && day < daily.length) daily[day].balance += event.amount;
    });
    for (var i = 1; i < daily.length; i += 1) daily[i].balance += daily[i - 1].balance;
    return daily;
  }

  function lowestPoint(series) {
    return series.reduce(function (lowest, point) {
      return point.balance < lowest.balance ? point : lowest;
    }, series[0]);
  }

  function seededReceiptValue(trial, id) {
    var seed = 2166136261;
    String(id).split("").forEach(function (character) {
      seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
    });
    var value = Math.imul((trial + 1) ^ seed, 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  }

  function simulateLowestBalances(options, samples, horizonDays) {
    var trialCount = samples || 500;
    var daysInView = Math.max(1, Number(horizonDays) || forecastHorizonDays || 30);
    var pending = state.transactions.filter(function (item) { return item.status === "forecast"; });
    var largestReceipt = pending.filter(function (item) { return item.type === "inflow"; }).sort(function (a, b) { return Number(b.amount) - Number(a.amount); })[0];
    var lowestBalances = [];

    for (var trial = 0; trial < trialCount; trial += 1) {
      var daily = Array(daysInView + 1).fill(0);
      pending.forEach(function (transaction) {
        var isReceipt = transaction.type === "inflow";
        if (isReceipt && seededReceiptValue(trial, transaction.id) >= receiptConfidence(transaction)) return;
        var date = transaction.date;
        if (isReceipt) date = shiftISO(date, receiptDelayDays(transaction, options, largestReceipt));
        if (options && transaction.key === "supplier") date = shiftISO(date, Number(options.supplierShiftDays) || 0);
        if (options && options.paymentShifts && options.paymentShifts[transaction.id]) date = shiftISO(date, Number(options.paymentShifts[transaction.id]) || 0);
        var amount = Number(transaction.amount) || 0;
        if (isReceipt && (transaction.key === "sales" || /sales/i.test(transaction.title)) && options && options.salesDrop) amount *= 1 - Number(options.salesDrop) / 100;
        var day = daysFromAnchor(date);
        if (day >= 0 && day < daily.length) daily[day] += isReceipt ? amount : -amount;
      });
      if (options && Number(options.extraExpense) > 0) {
        var expenseDay = daysFromAnchor(options.extraExpenseDate || "2026-11-06");
        if (expenseDay >= 0 && expenseDay < daily.length) daily[expenseDay] -= Number(options.extraExpense);
      }
      var balance = Number(state.openingCash) || 0;
      var lowest = balance;
      for (var index = 0; index < daily.length; index += 1) {
        balance += daily[index];
        if (balance < lowest) lowest = balance;
      }
      lowestBalances.push(lowest);
    }

    lowestBalances.sort(function (a, b) { return a - b; });
    return lowestBalances;
  }

  function percentile(sortedValues, probability) {
    if (!sortedValues.length) return 0;
    var quantilePosition = (sortedValues.length - 1) * Math.max(0, Math.min(1, probability));
    var lowerIndex = Math.floor(quantilePosition);
    var upperIndex = Math.ceil(quantilePosition);
    return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * (quantilePosition - lowerIndex);
  }

  function safeToSpend(options, simulatedLows) {
    var lowestBalances = simulatedLows || simulateLowestBalances(options, 500);
    var fifthPercentileLow = percentile(lowestBalances, 0.05);
    return Math.max(0, Math.floor((fifthPercentileLow - RESERVE) / 500) * 500);
  }

  function fundingAssessment(simulatedLows) {
    var fifthPercentileLow = percentile(simulatedLows, 0.05);
    var buffer = Math.ceil(Math.max(0, RESERVE - fifthPercentileLow) / 500) * 500;
    var coveredPaths = simulatedLows.filter(function (balance) { return balance + buffer >= RESERVE; }).length;
    return {
      fifthPercentileLow: fifthPercentileLow,
      buffer: buffer,
      coveredPaths: coveredPaths,
      totalPaths: simulatedLows.length,
      coveragePercent: simulatedLows.length ? coveredPaths / simulatedLows.length * 100 : 0
    };
  }

  function fundingScenarioLabel(options) {
    var changes = [];
    if (Number(options.delayDays) > 0) changes.push("largest receipt delayed " + Number(options.delayDays) + " days");
    Object.keys(options.receiptDelays || {}).forEach(function (id) {
      var transaction = state.transactions.find(function (item) { return item.id === id; });
      var days = Number(options.receiptDelays[id]) || 0;
      if (transaction && days > 0) changes.push(transaction.title + " delayed " + days + " days");
    });
    if (Number(options.salesDrop) > 0) changes.push("sales inflows reduced " + Number(options.salesDrop) + "%");
    if (Number(options.extraExpense) > 0) changes.push("unexpected expense " + money(Number(options.extraExpense)) + " on " + formatDate(options.extraExpenseDate || "2026-11-06", true));
    var supplierDays = Number(options.supplierShiftDays) || 0;
    if (supplierDays > 0) changes.push("supplier payment shifted " + supplierDays + " days");
    Object.keys(options.paymentShifts || {}).forEach(function (id) {
      var transaction = state.transactions.find(function (item) { return item.id === id; });
      var days = Number(options.paymentShifts[id]) || 0;
      if (transaction && days > 0 && transaction.key !== "supplier") changes.push(transaction.title + " shifted " + days + " days");
    });
    return changes.length ? changes.join(" · ") : "Base case using current forecast inputs";
  }

  function renderFundingReadiness(assessment, expectedLow, options) {
    byId("funding-buffer").textContent = money(assessment.buffer);
    byId("funding-p05-low").textContent = money(assessment.fifthPercentileLow);
    byId("funding-expected-low").textContent = money(expectedLow.balance);
    byId("funding-expected-low-date").textContent = formatDate(toISO(new Date(ANCHOR.getTime() + expectedLow.day * 86400000)), true);
    byId("funding-path-coverage").textContent = assessment.coveredPaths + " / " + assessment.totalPaths + " paths · " + assessment.coveragePercent.toFixed(1) + "%";
    byId("funding-scenario").textContent = fundingScenarioLabel(options);
  }

  function exportFundingBrief() {
    var reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      showToast("Allow this page to open a report window, then try again");
      return;
    }
    var options = currentScenarioOptions();
    var simulatedLows = simulateLowestBalances(options, 500);
    var assessment = fundingAssessment(simulatedLows);
    var expectedLow = lowestPoint(makeSeries(options));
    var reportStart = formatDate(toISO(ANCHOR), true);
    var reportEnd = formatDate(toISO(new Date(ANCHOR.getTime() + 30 * 86400000)), true);
    var createdAt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date());
    var pendingTransactions = state.transactions.filter(function (transaction) { return transaction.status === "forecast"; }).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var transactionRows = pendingTransactions.map(function (transaction) {
      var isReceipt = transaction.type === "inflow";
      return "<tr><td>" + escapeHTML(transaction.title) + "</td><td>" + (isReceipt ? "Expected receipt" : "Scheduled payment") + "</td><td>" + escapeHTML(formatDate(transaction.date, true)) + "</td><td>" + money(transaction.amount) + "</td><td>" + (isReceipt ? Math.round(receiptConfidence(transaction) * 100) + "%" : "Counted in full") + "</td></tr>";
    }).join("") || "<tr><td colspan=\"5\">No pending forecast transactions.</td></tr>";
    var backtestSummary = "No historical backtest observations were loaded. This brief makes no historical accuracy claim.";
    if (backtestResult && !backtestResult.error && backtestResult.observations && backtestResult.observations.length) {
      var observations = backtestResult.observations;
      var inBand = observations.filter(function (row) { return row.actualCash >= row.predictedLow && row.actualCash <= row.predictedHigh; }).length;
      backtestSummary = (backtestResult.qualifies ? "Six-month backtest criteria met" : "Provisional uploaded backtest") + ": " + Math.round(inBand / observations.length * 100) + "% coverage across " + observations.length + " observations (" + formatDate(backtestResult.oldestObservation, true) + " — " + formatDate(backtestResult.latestObservation, true) + ").";
    }
    var reportHtml = [
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>CaptiDict · Cash-flow funding brief</title>",
      "<style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;background:#eef3ee;color:#293a30;font:13px Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5}.report-sheet{max-width:900px;margin:24px auto;padding:38px;background:#fff;border:1px solid #e2ebe4;border-radius:18px;box-shadow:0 18px 50px rgba(37,69,44,.12)}.report-header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:20px;border-bottom:1px solid #e8eee9}.brand{display:flex;align-items:center;gap:12px}.brand-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:linear-gradient(140deg,#1b7d55,#63b17a);color:#fff;font-weight:800;font-size:18px}.brand h1{margin:0;font-size:20px}.brand p,.meta{margin:3px 0 0;color:#66756a;font-size:11px}.badge{display:inline-flex;padding:7px 10px;border:1px solid #dbece0;border-radius:20px;background:#f1f8f2;color:#32734a;font-size:10px;font-weight:750;letter-spacing:.35px;white-space:nowrap}.report-actions{display:flex;gap:8px;margin:19px 0}.report-actions button{border:1px solid #d8e6da;border-radius:9px;background:#f5faf6;color:#286b43;padding:9px 13px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.report-actions button:first-child{background:#26794e;color:white;border-color:#26794e}.title-row{margin:25px 0 18px}.kicker{color:#688072;font-size:10px;font-weight:750;letter-spacing:1px}.title-row h2{margin:5px 0 4px;font-size:26px;letter-spacing:-.6px}.title-row p{margin:0;color:#5e6e63;font-size:12px}.metric-grid{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:10px;margin:18px 0}.metric{padding:16px;border:1px solid #e3ece5;border-radius:12px;background:linear-gradient(140deg,#fff,#f2f8f3)}.metric.primary{border-color:#c9e4d0;background:linear-gradient(140deg,#f1faf3,#e7f5ea)}.metric small{display:block;color:#637568;font-size:9px;font-weight:750;letter-spacing:.55px}.metric strong{display:block;margin-top:8px;color:#263b2d;font-size:22px;font-variant-numeric:tabular-nums}.metric.primary strong{color:#217448;font-size:26px}.metric span{display:block;margin-top:5px;color:#647469;font-size:10px}.section{margin-top:21px;break-inside:avoid}.section h3{margin:0 0 9px;font-size:14px}.summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;padding:13px;border:1px solid #e6ede7;border-radius:11px;background:#fafcfa}.summary-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #edf1ed;font-size:11px}.summary-row span{color:#67766b}.summary-row strong{text-align:right}.scenario{padding:12px 14px;border:1px solid #e5ede6;border-radius:10px;background:#f8fbf8;color:#485a4c;font-size:11px}.table-wrap{overflow:hidden;border:1px solid #e2ebe4;border-radius:10px}table{width:100%;border-collapse:collapse;font-size:10px}th,td{padding:9px 10px;text-align:left;border-bottom:1px solid #e9eee9}th{background:#f4f8f4;color:#617166;font-size:9px;letter-spacing:.35px}td{color:#34483a}tr:last-child td{border-bottom:0}.note{padding:12px 14px;border-left:3px solid #4a9661;border-radius:0 9px 9px 0;background:#f2f8f3;color:#4d6052;font-size:10px}.note strong{color:#2e6f46}.warning{margin-top:12px;padding:12px 14px;border:1px solid #f0dfc5;border-radius:10px;background:#fffaf1;color:#725d3c;font-size:10px}.report-footer{margin-top:24px;padding-top:12px;border-top:1px solid #e8eee9;color:#758279;font-size:9px}.report-footer strong{color:#536559}@media(max-width:640px){.report-sheet{margin:0;padding:20px;border-radius:0}.report-header{flex-direction:column}.metric-grid{grid-template-columns:1fr 1fr}.metric.primary{grid-column:1/-1}.summary-grid{grid-template-columns:1fr}}@media print{body{background:#fff}.report-sheet{max-width:none;margin:0;padding:0;border:0;border-radius:0;box-shadow:none}.report-actions{display:none}.section,.metric,.summary-grid,.scenario,.note,.warning{break-inside:avoid}.report-header{padding-bottom:12px}.title-row{margin:18px 0 12px}.metric-grid{margin:12px 0}.section{margin-top:15px}}</style></head><body><main class=\"report-sheet\">",
      "<header class=\"report-header\"><div class=\"brand\"><span class=\"brand-mark\">F</span><div><h1>CaptiDict</h1><p>Cash-flow funding brief · Mitti &amp; Loom demo workspace</p></div></div><span class=\"badge\">⌑ &nbsp; GENERATED LOCALLY</span></header>",
      "<div class=\"report-actions\"><button id=\"print-report\" type=\"button\">Print / Save as PDF</button><button id=\"close-report\" type=\"button\">Close report</button></div>",
      "<section class=\"title-row\"><div class=\"kicker\">FUNDING READINESS · INDICATIVE MODEL</div><h2>Cash-flow funding brief</h2><p>Forecast window " + escapeHTML(reportStart) + " — " + escapeHTML(reportEnd) + " · Created " + escapeHTML(createdAt) + "</p></section>",
      "<section class=\"metric-grid\"><article class=\"metric primary\"><small>P95 ESTIMATED RESERVE BUFFER</small><strong>" + money(assessment.buffer) + "</strong><span>Indicative additional cash to keep the modeled low at or above the safety reserve in at least 95% of simulated paths.</span></article><article class=\"metric\"><small>FIFTH-PERCENTILE LOW (P05)</small><strong>" + money(assessment.fifthPercentileLow) + "</strong><span>Low cash before adding the estimated buffer.</span></article><article class=\"metric\"><small>SAFETY RESERVE</small><strong>" + money(RESERVE) + "</strong><span>Current reserve setting in CaptiDict.</span></article></section>",
      "<section class=\"section\"><h3>Current forecast summary</h3><div class=\"summary-grid\"><div class=\"summary-row\"><span>Opening cash</span><strong>" + money(state.openingCash) + "</strong></div><div class=\"summary-row\"><span>Expected-path lowest balance</span><strong>" + money(expectedLow.balance) + "</strong></div><div class=\"summary-row\"><span>Date of expected-path low</span><strong>" + escapeHTML(formatDate(toISO(new Date(ANCHOR.getTime() + expectedLow.day * 86400000)), true)) + "</strong></div><div class=\"summary-row\"><span>Modeled paths above reserve after buffer</span><strong>" + assessment.coveredPaths + " / " + assessment.totalPaths + " · " + assessment.coveragePercent.toFixed(1) + "%</strong></div><div class=\"summary-row\"><span>Pending receipts / payments</span><strong>" + pendingTransactions.filter(function (item) { return item.type === "inflow"; }).length + " / " + pendingTransactions.filter(function (item) { return item.type === "outflow"; }).length + "</strong></div><div class=\"summary-row\"><span>Scenario</span><strong>" + escapeHTML(fundingScenarioLabel(options)) + "</strong></div></div></section>",
      "<section class=\"section\"><h3>Pending transactions included</h3><div class=\"table-wrap\"><table><thead><tr><th>TRANSACTION</th><th>TYPE</th><th>EXPECTED DATE</th><th>INPUT AMOUNT</th><th>MODEL TREATMENT</th></tr></thead><tbody>" + transactionRows + "</tbody></table></div></section>",
      "<section class=\"section\"><h3>Historical backtest</h3><div class=\"scenario\">" + escapeHTML(backtestSummary) + "</div></section>",
      "<section class=\"section\"><h3>Method and assumptions</h3><div class=\"note\"><strong>Local, repeatable model.</strong> The app runs 500 seeded paths over the selected forecast window. In each path, a pending receipt arrives in full according to its entered confidence; scheduled payments count in full on their modeled dates. The P05 figure is the fifth percentile of each path’s lowest daily balance. The buffer is the reserve shortfall at that percentile, rounded up to the nearest ₹500. Results move when transaction amounts, dates, confidence, reserve, or scenario assumptions change.</div><div class=\"warning\"><strong>For planning discussion only.</strong> This is not a credit decision, loan offer, eligibility assessment, or guarantee of future cash or 95% real-world safety. Replace fictional demo values with verified records, review assumptions with your CA, and confirm required documents and facility terms directly with a lender.</div></section>",
      "<footer class=\"report-footer\"><strong>Privacy:</strong> This report is assembled in this browser from the current local workspace. It is not uploaded to CaptiDict, an AI service, or a bank. Share or store the exported file only through a channel you trust.</footer>",
      "</main></body></html>"
    ].join("");
    reportWindow.document.open();
    reportWindow.document.write(reportHtml);
    reportWindow.document.close();
    reportWindow.opener = null;
    reportWindow.document.getElementById("print-report").addEventListener("click", function () { reportWindow.print(); });
    reportWindow.document.getElementById("close-report").addEventListener("click", function () { reportWindow.close(); });
    showToast("Funding brief opened locally · choose Save as PDF in the print dialog");
    setTimeout(function () {
      try { reportWindow.focus(); reportWindow.print(); } catch (error) {}
    }, 350);
  }

  function totalByType(type) {
    return state.transactions.reduce(function (sum, transaction) {
      if (transaction.type !== type || transaction.status !== "forecast") return sum;
      return sum + Number(transaction.amount || 0);
    }, 0);
  }

  function weightedInflowTotal() {
    return state.transactions.reduce(function (sum, transaction) {
      if (transaction.type !== "inflow" || transaction.status !== "forecast") return sum;
      return sum + Number(transaction.amount || 0) * receiptConfidence(transaction);
    }, 0);
  }

  function scenarioTotals(options) {
    return projectedTransactions(options).reduce(function (totals, event) {
      var day = daysFromAnchor(event.date);
      if (day < 0 || day > 30) return totals;
      if (event.key === "surprise") {
        totals.extra += Math.abs(event.amount);
      } else if (event.amount >= 0) {
        totals.in += event.amount;
      } else {
        totals.out += Math.abs(event.amount);
      }
      return totals;
    }, { in: 0, out: 0, extra: 0 });
  }

  function firstShortfall(series) {
    return series.find(function (point) { return point.balance < 0; }) || null;
  }

  function healthCopy(low) {
    if (low.balance < 0) return { title: "A cash shortfall is possible", subtitle: "This scenario drops below zero before receipts arrive.", label: "Below zero" };
    if (low.balance < RESERVE) return { title: "Action needed before the tight week", subtitle: "Projected cash falls below your safety reserve.", label: shortMoney(RESERVE - low.balance) + " below reserve" };
    if (low.balance < RESERVE + 60000) return { title: "On track, with a watch-out", subtitle: "One week is close to your reserve.", label: shortMoney(low.balance - RESERVE) + " above reserve" };
    return { title: "Cash position looks steady", subtitle: "The projection stays above your safety reserve.", label: shortMoney(low.balance - RESERVE) + " above reserve" };
  }

  function linePath(series, bounds) {
    return series.map(function (point, index) {
      var x = bounds.left + index / (series.length - 1) * bounds.width;
      var y = bounds.top + (bounds.max - point.balance) / (bounds.max - bounds.min) * bounds.height;
      return (index === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
  }

  function renderChart(baseSeries, scenarioSeries, actionSeries, scenarioActive) {
    var svg = byId("cash-chart");
    var bounds = { left: 55, top: 12, width: 690, height: 218 };
    var all = baseSeries.concat(scenarioActive ? scenarioSeries : []).concat(actionSeries || []);
    var values = all.map(function (point) { return point.balance; }).concat([RESERVE, 0]);
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var range = Math.max(50000, max - min);
    min -= range * 0.1;
    max += range * 0.1;
    bounds.min = min;
    bounds.max = max;
    var markup = "";
    for (var tick = 0; tick <= 4; tick += 1) {
      var value = max - (max - min) * tick / 4;
      var y = bounds.top + bounds.height * tick / 4;
      markup += '<line x1="' + bounds.left + '" y1="' + y + '" x2="752" y2="' + y + '" stroke="#edf0ed" stroke-width="1"/>';
      markup += '<text x="0" y="' + (y + 3) + '" fill="#a0aaa3" font-size="9" font-family="system-ui">' + escapeHTML(shortMoney(value)) + "</text>";
    }
    var reserveY = bounds.top + (max - RESERVE) / (max - min) * bounds.height;
    markup += '<line x1="' + bounds.left + '" y1="' + reserveY + '" x2="752" y2="' + reserveY + '" stroke="#e0ad59" stroke-width="1.5" stroke-dasharray="5 5"/>';
    var area = linePath(baseSeries, bounds) + " L" + (bounds.left + bounds.width) + "," + (bounds.top + bounds.height) + " L" + bounds.left + "," + (bounds.top + bounds.height) + " Z";
    markup += '<path d="' + area + '" fill="#2c9b6e" opacity=".08"/>';
    markup += '<path d="' + linePath(baseSeries, bounds) + '" fill="none" stroke="#269768" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
    if (scenarioActive) markup += '<path d="' + linePath(scenarioSeries, bounds) + '" fill="none" stroke="#8d7ccd" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"/>';
    if (actionSeries) {
      markup += '<path d="' + linePath(actionSeries, bounds) + '" fill="none" stroke="#42a9a0" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    if (scenarioActive) {
      [0, 7, 14, 21, 30].forEach(function (day) {
        var point = scenarioSeries[day];
        var x = bounds.left + day / (scenarioSeries.length - 1) * bounds.width;
        var y = bounds.top + (max - point.balance) / (max - min) * bounds.height;
        markup += '<circle cx="' + x + '" cy="' + y + '" r="3" fill="#fff" stroke="#8d7ccd" stroke-width="1.5"/>';
      });
    }
    svg.innerHTML = markup;
  }

  function transactionActionLabel(transaction) {
    return transaction.type === "inflow" ? "Mark received" : "Mark paid";
  }

  function renderTransactionRows() {
    var upcoming = state.transactions.filter(function (transaction) { return transaction.status === "forecast"; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); }).slice(0, 4);
    byId("transaction-rows").innerHTML = upcoming.map(function (transaction) {
      var incoming = transaction.type === "inflow";
      var confidence = incoming ? Math.round(Number(transaction.confidence) * 100) + "%" : "Committed";
      return '<tr><td><span class="transaction-type"><i class="type-icon ' + (incoming ? "type-in" : "type-out") + '">' + (incoming ? "↘" : "↗") + '</i>' + escapeHTML(transaction.title) + '</span></td><td>' + formatDate(transaction.date) + '</td><td><span class="confidence"><i class="confidence-dot"></i>' + confidence + '</span></td><td class="amount-cell">' + (incoming ? "+" : "−") + money(transaction.amount) + '</td><td><div class="transaction-actions"><button class="table-action" data-transaction-action="' + escapeHTML(transaction.id) + '" title="' + transactionActionLabel(transaction) + '">' + transactionActionLabel(transaction) + '</button><button class="table-action table-action-delete" data-transaction-delete="' + escapeHTML(transaction.id) + '" aria-label="Delete ' + escapeHTML(transaction.title) + '">Delete</button></div></td></tr>';
    }).join("") || '<tr><td colspan="5">No upcoming transactions. Add one to build your forecast.</td></tr>';

    var all = state.transactions.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    byId("all-transaction-rows").innerHTML = all.map(function (transaction) {
      var incoming = transaction.type === "inflow";
      var statusLabel = transaction.status === "forecast" ? "Forecast" : (transaction.status === "received" ? "Received" : transaction.status === "failed" ? "Failed" : "Paid");
      var action = transaction.status === "forecast"
        ? '<button class="table-action" data-transaction-action="' + escapeHTML(transaction.id) + '" aria-label="' + transactionActionLabel(transaction) + ' ' + escapeHTML(transaction.title) + '">' + transactionActionLabel(transaction) + '</button>'
        : transaction.status === "failed" ? "—" : '<button class="table-action table-action-undo" data-transaction-undo="' + escapeHTML(transaction.id) + '" aria-label="Undo marking ' + escapeHTML(transaction.title) + ' as ' + statusLabel.toLowerCase() + '">Undo</button>';
      return '<tr><td>' + escapeHTML(transaction.title) + '</td><td><span class="transaction-type"><i class="type-icon ' + (incoming ? "type-in" : "type-out") + '">' + (incoming ? "↘" : "↗") + '</i>' + (incoming ? "Inflow" : "Outflow") + '</span></td><td>' + formatDate(transaction.date, true) + '</td><td>' + (incoming ? Math.round(Number(transaction.confidence) * 100) + "%" : "Committed") + '</td><td class="amount-cell">' + (incoming ? "+" : "−") + money(transaction.amount) + '</td><td><span class="status-pill ' + (transaction.status === "forecast" ? "" : transaction.status) + '">' + statusLabel + '</span></td><td><div class="transaction-actions">' + action + '<button class="table-action table-action-delete" data-transaction-delete="' + escapeHTML(transaction.id) + '" aria-label="Delete ' + escapeHTML(transaction.title) + '">Delete</button></div></td></tr>';
    }).join("") || '<tr><td colspan="7">No transactions added yet.</td></tr>';
  }

  function chaseItems() {
    return state.transactions.filter(function (transaction) {
      return transaction.type === "inflow" && transaction.status === "forecast" && !/\bsales\b/i.test(transaction.title);
    }).map(function (transaction) {
      var day = daysFromAnchor(transaction.date);
      var urgency = day < 0 ? 1.5 : (day <= 3 ? 1.35 : (day <= 7 ? 1.2 : (day <= 14 ? 1.1 : 1)));
      var weightedAmount = Number(transaction.amount) * receiptConfidence(transaction);
      return { transaction: transaction, day: day, weightedAmount: weightedAmount, urgency: urgency, priorityScore: weightedAmount * urgency };
    }).sort(function (a, b) {
      return b.priorityScore - a.priorityScore || a.day - b.day;
    });
  }

  function chaseTiming(day) {
    if (day < 0) return "Expected date passed " + Math.abs(day) + " day" + (Math.abs(day) === 1 ? "" : "s") + " ago";
    if (day === 0) return "Expected today";
    return "Expected in " + day + " day" + (day === 1 ? "" : "s");
  }

  function chaseParts(transaction) {
    var pieces = String(transaction.title).split(" · ");
    return { customer: pieces[0] || "Customer", reference: pieces[1] || "payment" };
  }

  function chaseDraft(transaction, tone) {
    var details = chaseParts(transaction);
    var amount = money(transaction.amount);
    var expectedDate = formatDate(transaction.date, true);
    var reference = /invoice/i.test(details.reference) ? details.reference : (details.reference === "payment" ? "expected payment" : details.reference);
    if (tone === "firm") {
      return "Hello " + details.customer + ",\n\nOur forecast has " + reference + " for " + amount + " expected on " + expectedDate + ". Please confirm whether payment is on track or share an updated expected date so we can keep our records current. If payment is already arranged, please let us know.\n\nRegards,\nMitti & Loom";
    }
    if (tone === "final") {
      return "Hello " + details.customer + ",\n\nPlease confirm the status of " + reference + " for " + amount + ", currently expected on " + expectedDate + ". If the timing has changed, please share an updated expected date so we can keep our cash-flow records accurate. If payment is already in process, please disregard this reminder.\n\nRegards,\nMitti & Loom";
    }
    return "Hi " + details.customer + ",\n\nHope you’re well. We have " + reference + " for " + amount + " noted with an expected payment date of " + expectedDate + ". Could you let us know if that timing still works?\n\nThank you,\nMitti & Loom";
  }

  function renderChaseFeatures(forceDraft) {
    var items = chaseItems();
    var oldSelected = selectedChaseId;
    if (!items.some(function (item) { return item.transaction.id === selectedChaseId; })) {
      selectedChaseId = items.length ? items[0].transaction.id : "";
      if (oldSelected !== selectedChaseId) chaseDraftEdited = false;
    }
    byId("receivables-count").textContent = String(items.length);
    byId("chase-list").innerHTML = items.map(function (item, index) {
      var transaction = item.transaction;
      var details = chaseParts(transaction);
      var selected = transaction.id === selectedChaseId;
      return '<button class="chase-item' + (selected ? ' selected' : '') + '" type="button" data-chase-select="' + escapeHTML(transaction.id) + '" aria-pressed="' + selected + '"><span class="chase-rank">' + (index + 1) + '</span><span class="chase-item-main"><strong>' + escapeHTML(details.customer) + '</strong><small>' + escapeHTML(details.reference) + ' · ' + escapeHTML(chaseTiming(item.day)) + '</small><span class="chase-confidence"><i></i>' + Math.round(receiptConfidence(transaction) * 100) + '% receipt confidence</span></span><span class="chase-value"><strong>' + money(transaction.amount) + '</strong><small>' + money(item.weightedAmount) + ' expected</small></span><span class="chase-arrow">›</span></button>';
    }).join("") || '<div class="chase-empty"><span>✓</span><strong>No pending customer receipts</strong><p>Add an incoming customer receipt in All transactions to build this list. Projected sales are excluded.</p></div>';

    var overviewItems = items.slice(0, 2);
    byId("overview-chase-list").innerHTML = overviewItems.map(function (item, index) {
      var transaction = item.transaction;
      var details = chaseParts(transaction);
      return '<button class="overview-chase-row" type="button" data-chase-open="' + escapeHTML(transaction.id) + '"><span class="overview-chase-rank">' + (index + 1) + '</span><span class="overview-chase-main"><strong>' + escapeHTML(details.customer) + '</strong><small>' + escapeHTML(details.reference) + ' · ' + escapeHTML(chaseTiming(item.day)) + '</small></span><span class="overview-chase-amount"><strong>' + money(transaction.amount) + '</strong><small>' + money(item.weightedAmount) + ' expected</small></span><span class="chase-arrow">›</span></button>';
    }).join("") || '<div class="overview-chase-empty">No pending customer receipts to follow up.</div>';

    var selected = items.find(function (item) { return item.transaction.id === selectedChaseId; });
    var draft = byId("chase-draft-text");
    var copyButton = byId("chase-copy-btn");
    var label = byId("chase-selected-label");
    var status = byId("chase-copy-status");
    if (!selected) {
      label.textContent = "Choose a receipt from the list.";
      draft.value = "";
      draft.disabled = true;
      copyButton.disabled = true;
      status.textContent = "No pending receipt selected.";
    } else {
      var details = chaseParts(selected.transaction);
      label.textContent = details.customer + " · " + details.reference + " · Expected " + formatDate(selected.transaction.date, true);
      draft.disabled = false;
      copyButton.disabled = false;
      if (forceDraft || !chaseDraftEdited || !draft.value) {
        draft.value = chaseDraft(selected.transaction, selectedChaseTone);
        chaseDraftEdited = false;
        status.textContent = "Review and edit before using.";
      }
    }
    document.querySelectorAll("[data-chase-tone]").forEach(function (button) {
      var active = button.getAttribute("data-chase-tone") === selectedChaseTone;
      button.disabled = !selected;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function setTransactionTab(tab) {
    activeTransactionTab = tab === "receivables" ? "receivables" : "all";
    document.querySelectorAll("[data-transaction-tab]").forEach(function (button) {
      var active = button.getAttribute("data-transaction-tab") === activeTransactionTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-transaction-pane]").forEach(function (pane) {
      pane.hidden = pane.getAttribute("data-transaction-pane") !== activeTransactionTab;
    });
  }

  function openReceivables(transactionId) {
    if (transactionId) selectedChaseId = transactionId;
    chaseDraftEdited = false;
    switchPage("transactions", true);
    setTransactionTab("receivables");
    renderChaseFeatures(true);
  }

  function updateControlDisplay() {
    byId("delay-control").value = state.scenario.delayDays;
    byId("expense-control").value = state.scenario.extraExpense;
    byId("sales-control").value = state.scenario.salesDrop;
    byId("delay-value").textContent = state.scenario.delayDays;
    byId("expense-value").textContent = new Intl.NumberFormat("en-IN").format(state.scenario.extraExpense);
    byId("sales-value").textContent = state.scenario.salesDrop;
    byId("expense-date").value = state.scenario.extraExpenseDate || "2026-11-06";
    byId("apply-action-btn").textContent = state.scenario.supplierShiftDays ? "Remove supplier extension" : "Compare this move";
    byId("action-card").classList.toggle("applied", state.scenario.supplierShiftDays > 0);
    var moveLegend = byId("move-legend");
    if (moveLegend) moveLegend.style.display = state.scenario.supplierShiftDays ? "flex" : "none";
    var actionTitle = byId("action-card").querySelector("strong");
    var actionDescription = byId("action-card").querySelector("p");
    if (state.scenario.supplierShiftDays) {
      actionTitle.textContent = "The extension protects the tight week";
      actionDescription.textContent = "The revised payment date keeps more cash available while the unexpected cost lands.";
    } else {
      actionTitle.textContent = "Ask your supplier for a 14-day extension";
      actionDescription.textContent = "See whether shifting one payment gives you more room during the tight week.";
    }
  }

  function updateWhatIfApplied() {
    var container = byId("what-if-applied");
    if (!state.scenario.whatIfApplied) {
      container.hidden = true;
      return;
    }
    var assumptions = [];
    Object.keys(state.scenario.receiptDelays || {}).forEach(function (id) {
      var transaction = state.transactions.find(function (item) { return item.id === id && item.type === "inflow" && item.status === "forecast"; });
      var days = Number(state.scenario.receiptDelays[id]);
      if (transaction && days > 0) assumptions.push(transaction.title.split(" · ")[0] + " +" + days + " days");
    });
    if (Number(state.scenario.delayDays) > 0) assumptions.push("largest receipt +" + Number(state.scenario.delayDays) + " days");
    if (Number(state.scenario.salesDrop) > 0) assumptions.push("sales −" + Number(state.scenario.salesDrop) + "%");
    if (Number(state.scenario.extraExpense) > 0) assumptions.push("extra outflow " + money(state.scenario.extraExpense) + " on " + formatDate(state.scenario.extraExpenseDate || "2026-11-06"));
    if (Number(state.scenario.supplierShiftDays) > 0) assumptions.push("supplier +" + Number(state.scenario.supplierShiftDays) + " days");
    if (!assumptions.length) {
      container.hidden = true;
      return;
    }
    byId("what-if-applied-copy").textContent = assumptions.join(" · ");
    container.hidden = false;
  }

  function actionPlanItems(low) {
    var pendingReceipts = state.transactions.filter(function (item) { return item.type === "inflow" && item.status === "forecast"; }).sort(function (a, b) { return b.amount - a.amount; });
    var largestReceipt = pendingReceipts[0];
    var supplier = state.transactions.find(function (item) { return item.key === "supplier" && item.status === "forecast"; });
    var scenario = state.scenario;
    var beforeExtension = lowestPoint(makeSeries({ delayDays: scenario.delayDays, extraExpense: scenario.extraExpense, extraExpenseDate: scenario.extraExpenseDate, salesDrop: scenario.salesDrop, supplierShiftDays: 0, paymentShifts: scenario.paymentShifts || {}, receiptDelays: scenario.receiptDelays || {} }));
    var afterExtension = lowestPoint(makeSeries({ delayDays: scenario.delayDays, extraExpense: scenario.extraExpense, extraExpenseDate: scenario.extraExpenseDate, salesDrop: scenario.salesDrop, supplierShiftDays: 14, paymentShifts: scenario.paymentShifts || {}, receiptDelays: scenario.receiptDelays || {} }));
    var nextWeekOutflows = projectedTransactions({ delayDays: scenario.delayDays, extraExpense: scenario.extraExpense, extraExpenseDate: scenario.extraExpenseDate, salesDrop: scenario.salesDrop, supplierShiftDays: scenario.supplierShiftDays, paymentShifts: scenario.paymentShifts || {}, receiptDelays: scenario.receiptDelays || {} }).filter(function (event) { var day = daysFromAnchor(event.date); return event.amount < 0 && event.key !== "surprise" && day >= 0 && day <= 7; }).reduce(function (sum, event) { return sum + Math.abs(event.amount); }, 0);
    var items = [];
    if (largestReceipt) {
      var confidence = receiptConfidence(largestReceipt);
      var confidenceGap = Math.round(Number(largestReceipt.amount) * (1 - confidence));
      var largestReceiptDelay = receiptDelayDays(largestReceipt, scenario, pendingReceipts[0]);
      items.push({ id: "confirm-receipt", rank: 1, title: "Confirm the largest expected receipt", description: largestReceipt.title + " · due " + formatDate(shiftISO(largestReceipt.date, largestReceiptDelay)) + " · " + Math.round(confidence * 100) + "% confidence.", impact: confidenceGap ? money(confidenceGap) + " difference between full collection and the weighted estimate" : "Confirm the expected date before relying on it", button: "Follow up on date and partial-payment options" });
    } else {
      items.push({ id: "confirm-receipt", rank: 1, title: "Review expected receipts", description: "There are no pending receipts in the current forecast.", impact: "Keep the forecast current", button: "Review your transaction list" });
    }
    if (supplier) {
      var improvement = Math.max(0, Math.round(afterExtension.balance - beforeExtension.balance));
      items.push({ id: "supplier-extension", rank: 2, title: "Discuss supplier payment timing", description: supplier.title + " · currently due " + formatDate(supplier.date) + ". Compare a possible 14-day extension.", impact: improvement ? "Modeled low improves by " + money(improvement) : "Compare the 14-day timing change", button: "Compare in what-if scenario" });
    } else {
      items.push({ id: "supplier-extension", rank: 2, title: "Review payment timing", description: "No matching supplier payment is currently pending.", impact: "Check due dates and commitments", button: "Review your transaction list" });
    }
    items.push({ id: "payment-huddle", rank: 3, title: "Check this week’s payment dates", description: nextWeekOutflows ? money(nextWeekOutflows) + " in scheduled outflows fall within the first 7 days of this view." : "No forecast outflows are listed in the first 7 days.", impact: low.balance < RESERVE ? "Reserve is under pressure" : "Keep commitments and due dates confirmed", button: "Review dates with your team" });
    return items;
  }

  function renderActionPlan(low) {
    var items = actionPlanItems(low);
    byId("action-plan-list").innerHTML = items.map(function (item) {
      var complete = state.completedActions.indexOf(item.id) !== -1;
      return '<article class="action-plan-item ' + (complete ? "completed" : "") + '"><label class="action-plan-check-control"><input type="checkbox" data-action-toggle="' + item.id + '" ' + (complete ? "checked" : "") + '><span class="action-plan-check" aria-hidden="true">✓</span><span class="sr-only">Mark ' + escapeHTML(item.title) + ' complete</span></label><span class="action-plan-copy"><small>PRIORITY ' + item.rank + '</small><strong>' + escapeHTML(item.title) + '</strong><span>' + escapeHTML(item.description) + '</span><em>' + escapeHTML(item.impact) + '</em></span><button class="action-plan-next" type="button" data-plan-action="' + item.id + '">' + escapeHTML(item.button) + ' →</button></article>';
    }).join("");
  }

  function calculatePayOrder(options) {
    var currentOptions = Object.assign({}, options || {});
    currentOptions.paymentShifts = Object.assign({}, currentOptions.paymentShifts || {});
    var currentLow = lowestPoint(makeSeries(currentOptions));
    var projectedById = {};
    projectedTransactions(currentOptions).forEach(function (event) {
      if (event.id) projectedById[event.id] = event;
    });
    var items = state.transactions.filter(function (transaction) {
      return transaction.type === "outflow" && transaction.status === "forecast" && daysFromAnchor(transaction.date) >= 0 && daysFromAnchor(transaction.date) <= 30;
    }).map(function (transaction) {
      var event = projectedById[transaction.id];
      var cost = transaction.delayCostPerWeek;
      var hasCost = cost !== null && cost !== undefined && cost !== "" && Number.isFinite(Number(cost)) && Number(cost) >= 0;
      return {
        transaction: transaction,
        date: event ? event.date : transaction.date,
        hasCost: hasCost,
        delayCostPerWeek: hasCost ? Number(cost) : null,
        costPerThousand: hasCost && Number(transaction.amount) > 0 ? Number(cost) / Number(transaction.amount) * 1000 : null,
        canDefer: transaction.canDefer === true,
        alreadyShifted: Number(currentOptions.paymentShifts[transaction.id]) > 0 || (transaction.key === "supplier" && Number(currentOptions.supplierShiftDays) > 0)
      };
    });
    items.sort(function (a, b) {
      if (a.hasCost !== b.hasCost) return a.hasCost ? 1 : -1;
      if (!a.hasCost) return a.date.localeCompare(b.date);
      return b.costPerThousand - a.costPerThousand || a.date.localeCompare(b.date);
    });

    var proposedShifts = Object.assign({}, currentOptions.paymentShifts);
    var deferredIds = [];
    var estimatedDelayCost = 0;
    var planLow = currentLow;
    if (currentLow.balance < RESERVE) {
      var candidates = items.filter(function (item) {
        return item.canDefer && item.hasCost && !item.alreadyShifted;
      }).sort(function (a, b) {
        return a.costPerThousand - b.costPerThousand || a.date.localeCompare(b.date);
      });
      candidates.forEach(function (item) {
        if (planLow.balance >= RESERVE) return;
        var testShifts = Object.assign({}, proposedShifts);
        testShifts[item.transaction.id] = 14;
        var testOptions = Object.assign({}, currentOptions, { paymentShifts: testShifts });
        var testLow = lowestPoint(makeSeries(testOptions));
        if (testLow.balance > planLow.balance) {
          proposedShifts[item.transaction.id] = 14;
          deferredIds.push(item.transaction.id);
          estimatedDelayCost += item.delayCostPerWeek * 2;
          planLow = testLow;
        }
      });
    }
    return {
      items: items,
      currentLow: currentLow,
      planLow: planLow,
      deferredIds: deferredIds,
      proposedShifts: proposedShifts,
      estimatedDelayCost: estimatedDelayCost,
      reserveAtRisk: currentLow.balance < RESERVE
    };
  }

  function renderPayOrderPlanner(options) {
    var container = byId("pay-order-planner");
    var plan = calculatePayOrder(options);
    var selected = new Set(plan.deferredIds);
    var alreadyApplied = Object.keys(options.paymentShifts || {}).some(function (id) { return Number(options.paymentShifts[id]) > 0; });
    var status;
    if (!plan.reserveAtRisk) {
      status = '<div class="pay-order-status covered"><strong>No reserve breach in this scenario.</strong><span>Use the ranking below to protect bills with a higher estimated delay cost. No date change is suggested.</span></div>';
    } else if (plan.deferredIds.length) {
      var selectedNames = plan.items.filter(function (item) { return selected.has(item.transaction.id); }).map(function (item) { return item.transaction.title; }).join(" · ");
      var outcome = plan.planLow.balance >= RESERVE
        ? "The modeled low reaches the safety reserve."
        : "The modeled low remains below the safety reserve.";
      status = '<div class="pay-order-status at-risk"><strong>Reserve pressure found · modeled low ' + money(plan.currentLow.balance) + ' on ' + formatDate(toISO(new Date(ANCHOR.getTime() + plan.currentLow.day * 86400000))) + '.</strong><span>Discuss moving ' + escapeHTML(selectedNames) + ' by 14 days. The comparison moves the low to ' + money(plan.planLow.balance) + '. ' + outcome + ' Estimated 14-day delay cost: ' + money(plan.estimatedDelayCost) + ' using your weekly estimates.</span><div class="pay-order-actions"><button class="button button-primary" type="button" data-pay-order-apply>Apply comparison to forecast</button></div><small>This changes the forecast scenario only; transaction dates remain unchanged.</small></div>';
    } else {
      var alreadyMovedCount = plan.items.filter(function (item) { return item.canDefer && item.hasCost && item.alreadyShifted; }).length;
      var appliedMessage = alreadyMovedCount ? "The current scenario already shifts " + alreadyMovedCount + " marked negotiable payment" + (alreadyMovedCount === 1 ? ". " : "s. ") : "";
      status = '<div class="pay-order-status at-risk"><strong>Reserve pressure found · modeled low ' + money(plan.currentLow.balance) + ' on ' + formatDate(toISO(new Date(ANCHOR.getTime() + plan.currentLow.day * 86400000))) + '.</strong><span>' + appliedMessage + 'No unshifted bill is both marked negotiable and assigned a delay-cost estimate, so no deferral is suggested. Add verified estimates and discuss dates before changing commitments.</span></div>';
    }
    var rows = plan.items.map(function (item, index) {
      var transaction = item.transaction;
      var isSelected = selected.has(transaction.id);
      var recommendation = isSelected ? "Discuss +14 days" : (item.alreadyShifted ? "Scenario +14 days" : (!item.hasCost ? "Set estimate" : (plan.reserveAtRisk ? "Protect · pay earlier" : "Priority " + (index + 1))));
      var costValue = item.hasCost ? String(item.delayCostPerWeek) : "";
      var score = item.hasCost ? "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(item.costPerThousand) : "—";
      var decisionClass = isSelected ? "defer" : (item.alreadyShifted ? "applied" : (!item.hasCost ? "unknown" : "pay"));
      return '<tr class="' + (isSelected ? "pay-order-defer-row" : "") + '"><td><span class="pay-order-decision ' + decisionClass + '">' + recommendation + '</span></td><td><strong>' + escapeHTML(transaction.title) + '</strong><small>Due ' + formatDate(item.date, true) + '</small></td><td class="amount-cell">' + money(transaction.amount) + '</td><td><label class="pay-cost-input"><span class="sr-only">Estimated cost per week of delaying ' + escapeHTML(transaction.title) + '</span><span>₹</span><input type="number" min="0" step="100" inputmode="numeric" placeholder="Set estimate" value="' + escapeHTML(costValue) + '" data-pay-cost="' + escapeHTML(transaction.id) + '"></label></td><td><span class="pay-order-score">' + score + '</span></td><td><label class="pay-negotiable"><input type="checkbox" data-pay-negotiable="' + escapeHTML(transaction.id) + '" ' + (item.canDefer ? "checked" : "") + '><span>Can discuss date</span></label></td></tr>';
    }).join("") || '<tr><td colspan="6" class="pay-order-empty">No forecast payments fall inside this 30-day window.</td></tr>';
    var applied = alreadyApplied ? '<button class="button button-quiet" type="button" data-pay-order-clear>Remove applied pay-order moves</button>' : "";
    container.innerHTML = status + '<div class="pay-order-table-wrap"><table class="pay-order-table"><thead><tr><th>RECOMMENDATION</th><th>PAYMENT</th><th>AMOUNT</th><th>ESTIMATED DELAY / WEEK</th><th>COST PER ₹1,000 / WEEK</th><th>NEGOTIABLE?</th></tr></thead><tbody>' + rows + '</tbody></table></div><div class="pay-order-foot"><span>Higher cost per ₹1,000 ranks earlier for payment. Unknown costs are never automatically deferred.</span>' + applied + '</div>';
  }


  function updateForecastRangeUI(series) {
    var select = byId("forecast-horizon");
    if (select && Number(select.value) !== forecastHorizonDays) select.value = String(forecastHorizonDays);
    var kicker = byId("forecast-kicker");
    if (kicker) kicker.innerHTML = forecastHorizonDays === 30 ? '30-DAY OUTLOOK <span class="tiny-info" title="Forecast receipts are weighted by the confidence shown in each transaction.">i</span>' :
      (forecastHorizonDays === 90 ? '3-MONTH OUTLOOK <span class="tiny-info" title="Forecast receipts are weighted by the confidence shown in each transaction.">i</span>' :
      (forecastHorizonDays === 180 ? '6-MONTH OUTLOOK <span class="tiny-info" title="Forecast receipts are weighted by the confidence shown in each transaction.">i</span>' :
      '1-YEAR OUTLOOK <span class="tiny-info" title="Forecast receipts are weighted by the confidence shown in each transaction.">i</span>'));
    var endDate = new Date(ANCHOR.getTime() + forecastHorizonDays * 86400000);
    var rangeLabel = byId("forecast-range-label");
    if (rangeLabel) rangeLabel.textContent = formatDate(toISO(ANCHOR)) + " — " + formatDate(toISO(endDate));
    var expenseDate = byId("expense-date");
    if (expenseDate) {
      expenseDate.max = toISO(endDate);
      if (daysFromAnchor(expenseDate.value) > forecastHorizonDays) {
        expenseDate.value = toISO(new Date(ANCHOR.getTime() + Math.min(13, forecastHorizonDays) * 86400000));
      }
    }
    var labels = byId("forecast-xlabels");
    if (labels) {
      var points = [0, 0.25, 0.5, 0.75, 1];
      labels.innerHTML = points.map(function (fraction) {
        var date = new Date(ANCHOR.getTime() + Math.round(forecastHorizonDays * fraction) * 86400000);
        return "<span>" + escapeHTML(formatDate(toISO(date))) + "</span>";
      }).join("");
    }
  }

  function render() {
    var scenario = state.scenario;
    var baseSeries = makeSeries({ delayDays: 0, extraExpense: 0, salesDrop: 0, supplierShiftDays: 0 }, forecastHorizonDays);
    var scenarioSeries = makeSeries({
      delayDays: scenario.delayDays,
      extraExpense: scenario.extraExpense,
      extraExpenseDate: scenario.extraExpenseDate,
      salesDrop: scenario.salesDrop,
      supplierShiftDays: 0,
      paymentShifts: scenario.paymentShifts || {},
      receiptDelays: scenario.receiptDelays || {}
    }, forecastHorizonDays);
    var actionSeries = scenario.supplierShiftDays ? makeSeries({
      delayDays: scenario.delayDays,
      extraExpense: scenario.extraExpense,
      extraExpenseDate: scenario.extraExpenseDate,
      salesDrop: scenario.salesDrop,
      supplierShiftDays: 14,
      paymentShifts: scenario.paymentShifts || {},
      receiptDelays: scenario.receiptDelays || {}
    }, forecastHorizonDays) : null;
    var activeSeries = actionSeries || scenarioSeries;
    var low = lowestPoint(activeSeries);
    var health = healthCopy(low);
    var summaryOptions = {
      delayDays: scenario.delayDays,
      extraExpense: scenario.extraExpense,
      extraExpenseDate: scenario.extraExpenseDate,
      salesDrop: scenario.salesDrop,
      supplierShiftDays: scenario.supplierShiftDays ? 14 : 0,
      paymentShifts: scenario.paymentShifts || {},
      receiptDelays: scenario.receiptDelays || {}
    };
    var totals = scenarioTotals(summaryOptions);
    var simulatedLows = simulateLowestBalances(summaryOptions, 500, forecastHorizonDays);
    var funding = fundingAssessment(simulatedLows);
    byId("topbar-safe-spend-value").textContent = money(safeToSpend(summaryOptions, simulatedLows));
    var endingCash = activeSeries[activeSeries.length - 1].balance;
    var netMovement = endingCash - Number(state.openingCash || 0);
    var shortfall = firstShortfall(activeSeries);
    renderFundingReadiness(funding, low, summaryOptions);
    var scenarioActive = scenario.delayDays > 0 || scenario.extraExpense > 0 || scenario.salesDrop > 0 || Object.keys(scenario.paymentShifts || {}).some(function (id) { return Number(scenario.paymentShifts[id]) > 0; }) || Object.keys(scenario.receiptDelays || {}).some(function (id) { return Number(scenario.receiptDelays[id]) > 0; });
    var modeledEvents = projectedTransactions(summaryOptions).filter(function (event) { var day = daysFromAnchor(event.date); return day >= 0 && day <= forecastHorizonDays; });
    var receiptCount = modeledEvents.filter(function (event) { return event.amount > 0; }).length;
    var paymentCount = modeledEvents.filter(function (event) { return event.amount < 0 && event.key !== "surprise"; }).length;
    var largest = state.transactions.filter(function (transaction) { return transaction.type === "inflow" && transaction.status === "forecast"; }).sort(function (a, b) { return b.amount - a.amount; })[0];

    byId("metric-cash").textContent = money(state.openingCash);
    byId("metric-endcash").textContent = money(endingCash);
    byId("metric-net").textContent = money(netMovement);
    byId("metric-net").style.color = netMovement < 0 ? "#bf6258" : "#2e8258";
    byId("metric-runway").textContent = shortfall ? shortfall.day + " days" : forecastHorizonDays + "+ days";
    byId("metric-runway-note").textContent = shortfall ? "First shortfall · " + formatDate(toISO(new Date(ANCHOR.getTime() + shortfall.day * 86400000))) : "No negative balance in this view";
    byId("metric-alerts").textContent = low.balance < RESERVE + 60000 ? "1" : "0";
    byId("metric-health").textContent = health.label;
    byId("metric-low-date").textContent = formatDate(toISO(new Date(ANCHOR.getTime() + low.day * 86400000)));
    byId("metric-health").style.color = low.balance < RESERVE ? "#be6550" : "#a97823";
    byId("health-title").textContent = health.title;
    byId("health-subtitle").textContent = health.subtitle;
    byId("health-receipts").textContent = receiptCount + " expected receipt" + (receiptCount === 1 ? "" : "s");
    byId("health-payments").textContent = paymentCount + " planned payment" + (paymentCount === 1 ? "" : "s");
    byId("health-receipt-total").textContent = shortMoney(totals.in);
    byId("health-payment-total").textContent = shortMoney(totals.out);
    if (largest) {
      var largestPending = state.transactions.filter(function (item) { return item.type === "inflow" && item.status === "forecast"; }).sort(function (a, b) { return Number(b.amount) - Number(a.amount); })[0];
      var largestDate = shiftISO(largest.date, receiptDelayDays(largest, scenario, largestPending));
      byId("largest-receipt-name").textContent = largest.title.split(" · ")[0] + " · " + formatDate(largestDate);
      byId("largest-receipt-total").textContent = shortMoney(largest.amount);
    } else {
      byId("largest-receipt-name").textContent = "No forecast receipts";
      byId("largest-receipt-total").textContent = "—";
    }
    byId("scenario-low").textContent = money(low.balance);
    byId("scenario-low-date").textContent = formatDate(toISO(new Date(ANCHOR.getTime() + low.day * 86400000)));
    byId("scenario-low-label").textContent = actionSeries ? "LOWEST BALANCE WITH EXTENSION" : "LOWEST BALANCE IN THIS SCENARIO";
    byId("scenario-result").classList.toggle("below-reserve", low.balance < RESERVE);
    var riskClass = low.balance < 0 ? "critical" : (low.balance < RESERVE ? "high" : (low.balance < RESERVE + 60000 ? "watch" : "healthy"));
    var riskBadge = low.balance < 0 ? "CRITICAL" : (low.balance < RESERVE ? "HIGH" : (low.balance < RESERVE + 60000 ? "WATCH" : "HEALTHY"));
    var riskTitle = low.balance < 0 ? "Potential cash shortfall" : (low.balance < RESERVE ? "Safety reserve breach" : (low.balance < RESERVE + 60000 ? "Reserve watch" : "Reserve covered"));
    var riskDate = formatDate(toISO(new Date(ANCHOR.getTime() + low.day * 86400000)));
    var riskCopy = low.balance < 0 ? "The modeled low is " + money(Math.abs(low.balance)) + " below zero on " + riskDate + ". Review assumptions and due dates." : (low.balance < RESERVE ? "The modeled low is " + money(RESERVE - low.balance) + " below the " + money(RESERVE) + " reserve on " + riskDate + "." : (low.balance < RESERVE + 60000 ? "The low is " + money(low.balance - RESERVE) + " above reserve on " + riskDate + ". Keep key dates confirmed." : "The lowest modeled balance is " + money(low.balance) + " on " + riskDate + ", above the reserve."));
    byId("risk-alert").className = "risk-alert " + riskClass;
    byId("risk-alert-badge").textContent = riskBadge;
    byId("risk-alert-title").textContent = riskTitle;
    byId("risk-alert-copy").textContent = riskCopy;
    byId("bridge-current-cash").textContent = money(state.openingCash);
    byId("bridge-opening").textContent = money(state.openingCash);
    byId("bridge-in").textContent = "+" + money(totals.in);
    byId("bridge-out").textContent = "−" + money(totals.out);
    byId("bridge-receipt-note").textContent = scenario.salesDrop ? "After " + scenario.salesDrop + "% sales reduction" : "Weighted by confidence";
    byId("bridge-surprise-row").hidden = !totals.extra;
    byId("bridge-surprise").textContent = "−" + money(totals.extra);
    byId("bridge-ending").textContent = money(endingCash);
    byId("overview-ending-cash").textContent = money(endingCash);
    // Keep the Overview runway card synced with the active saved reserve setting.
    var overviewReserve = byId("overview-safety-reserve");
    if (overviewReserve) overviewReserve.textContent = money(RESERVE);
    byId("overview-scenario-low").textContent = money(low.balance);
    byId("overview-scenario-label").textContent = actionSeries ? "WITH EXTENSION · LOWEST CASH" : (scenarioActive ? "LATE CUSTOMER · LOWEST CASH" : "BASE · LOWEST PROJECTED CASH");
    var gap = RESERVE - low.balance;
    var lowStatus = gap > 0 ? (shortfall ? "Shortfall on " : "Reserve breach on ") + formatDate(toISO(new Date(ANCHOR.getTime() + low.day * 86400000))) + " · " + money(gap) + " below reserve" : formatDate(toISO(new Date(ANCHOR.getTime() + low.day * 86400000))) + " · " + money(-gap) + " above reserve";
    byId("overview-scenario-date").textContent = lowStatus;
    document.querySelectorAll("[data-overview-scenario]").forEach(function (button) {
      var activeScenario = actionSeries ? "extension" : (scenarioActive ? "stress" : "base");
      button.classList.toggle("active", button.getAttribute("data-overview-scenario") === activeScenario);
      button.setAttribute("aria-selected", button.getAttribute("data-overview-scenario") === activeScenario ? "true" : "false");
    });
    var insight = actionSeries
      ? "<strong>Response comparison.</strong> With the extension, the low is " + money(low.balance) + "—still " + money(Math.max(0, RESERVE - low.balance)) + " below reserve."
      : (low.balance < 0
        ? "<strong>Shortfall risk.</strong> This scenario dips below zero. Compare a payment extension or follow up on expected receipts."
        : (low.balance < RESERVE
          ? "<strong>Reserve alert.</strong> This scenario falls below your safety reserve of " + money(RESERVE) + ". Compare a response before committing."
          : (low.balance < RESERVE + 60000
            ? "<strong>Breathing room is tight.</strong> Your projected low sits close to your safety reserve of " + money(RESERVE) + "."
            : "<strong>Your reserve stays covered.</strong> The lowest point keeps a comfortable distance from your safety reserve of " + money(RESERVE) + ".")));
    byId("chart-insight").querySelector("span:nth-child(2)").innerHTML = insight;
    byId("health-title").parentElement.parentElement.classList.toggle("alert-health", low.balance < RESERVE);
    byId("chart-insight").querySelector("a").textContent = actionSeries ? "View scenarios →" : (low.balance < RESERVE ? "Compare a move →" : "Stress-test it →");

    updateControlDisplay();
    updateWhatIfApplied();
    byId("scenario-legend").style.display = scenarioActive ? "flex" : "none";
    renderChart(baseSeries, scenarioSeries, actionSeries, scenarioActive);
    updateForecastRangeUI(baseSeries);
    renderTransactionRows();
    renderChaseFeatures(false);
    renderPayOrderPlanner(summaryOptions);
    renderActionPlan(low);
    var saved = saveState();
    var savedLabel = document.querySelector(".eyebrow");
    if (savedLabel) savedLabel.innerHTML = '<span class="live-dot"></span> <span id="current-system-date"></span> <span class="heading-separator">·</span> ' + (saved ? "SAVED ON THIS DEVICE" : "LOCAL STORAGE UNAVAILABLE");
    updateCurrentSystemDate();
  }

  function showToast(message) {
    var toast = byId("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 2600);
  }

  var pageDetails = {
    overview: { label: "Overview", title: "Your cash, <em>in view.</em>", intro: "A clear snapshot of current cash, commitments, and the choices that can give you more room." },
    forecast: { label: "Forecast", title: "Cash flow <em>forecast.</em>", intro: "Choose a 30-day, 3-month, 6-month, or 1-year cash path, test changes, compare a response, and estimate a funding buffer." },
    transactions: { label: "Transactions", title: "Every movement, <em>in view.</em>", intro: "Review receipts and payments, then prioritize customer follow-ups with editable local drafts." },
    projects: { label: "Projects", title: "Your work, <em>organized.</em>", intro: "Create and manage projects saved securely in your CaptiDict backend." },
    assistant: { label: "Private AI", title: "Ask about your cash, <em>privately.</em>", intro: "Get a transparent local explanation of your forecast without sending numbers to a server." },
    profile: { label: "Profile & settings", title: "Your account, <em>in view.</em>", intro: "Review your signed-in identity, replay the tutorial, and manage your session." },
    privacy: { label: "Privacy details", title: "Privacy, <em>without guesswork.</em>", intro: "Understand what stays in your browser, what uses the backend, and which controls are available." },
    guide: { label: "User guide", title: "Your workspace, <em>explained.</em>", intro: "Learn each feature, how to set up the demo inputs, and exactly how the cash forecast is calculated." }
  };

  function switchPage(page, updateAddress) {
    if (!pageDetails[page]) page = "overview";
    document.querySelectorAll("[data-page-view]").forEach(function (view) {
      var active = view.getAttribute("data-page-view") === page;
      view.hidden = !active;
      view.classList.toggle("active", active);
      view.classList.remove("page-enter");
      if (active) {
        void view.offsetWidth;
        view.classList.add("page-enter");
      }
    });
    document.querySelectorAll("[data-page-link]").forEach(function (link) {
      link.classList.toggle("active", link.getAttribute("data-page-link") === page);
    });
    byId("page-breadcrumb").textContent = pageDetails[page].label;
    byId("page-heading-title").innerHTML = pageDetails[page].title;
    byId("page-intro").textContent = pageDetails[page].intro;
    if (page === "projects") loadProjects();
    if (updateAddress) {
      try { history.replaceState(null, "", window.location.pathname + window.location.search + "#" + page); } catch (error) {}
    }
    window.scrollTo(0, 0);
  }

  // Projects are stored by the authenticated backend, separate from local demo transactions.
  var projectRecords = [];
  var projectRequestBusy = false;

  function projectApi(path, options) {
    var token = sessionStorage.getItem("srujana-token");
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    var requestOptions = options || {};
    requestOptions.headers = Object.assign({}, requestOptions.headers || {}, {
      "Authorization": "Bearer " + token
    });
    if (requestOptions.body && !requestOptions.headers["Content-Type"]) {
      requestOptions.headers["Content-Type"] = "application/json";
    }
    return fetch("http://localhost:4000/api/projects" + (path || ""), requestOptions).then(async function (response) {
      if (response.status === 204) return null;
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        var error = result.error || result;
        throw new Error(error.message || "Project request failed (" + response.status + ").");
      }
      return result;
    });
  }

  function renderProjects() {
    var tbody = byId("project-rows");
    if (!tbody) return;
    if (!projectRecords.length) {
      tbody.innerHTML = '<tr><td colspan="5">No projects yet. Use the form above to create your first project.</td></tr>';
      return;
    }
    tbody.innerHTML = projectRecords.map(function (project) {
      var updated = project.updatedAt ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(project.updatedAt)) : "—";
      var status = String(project.status || "active").toLowerCase();
      return '<tr>' +
        '<td><strong>' + escapeHTML(project.title || "Untitled project") + '</strong></td>' +
        '<td>' + escapeHTML(project.description || "—") + '</td>' +
        '<td><span class="status-pill">' + escapeHTML(status.charAt(0).toUpperCase() + status.slice(1)) + '</span></td>' +
        '<td>' + escapeHTML(updated) + '</td>' +
        '<td><button class="button button-quiet compact" type="button" data-project-edit="' + escapeHTML(project.id) + '">Edit</button> <button class="button button-quiet compact" type="button" data-project-delete="' + escapeHTML(project.id) + '">Delete</button></td>' +
      '</tr>';
    }).join("");
  }

  async function loadProjects() {
    if (!byId("project-rows") || projectRequestBusy) return;
    projectRequestBusy = true;
    byId("projects-message").textContent = "Loading projects from the backend…";
    try {
      var result = await projectApi("");
      projectRecords = Array.isArray(result && result.data) ? result.data : [];
      renderProjects();
      byId("projects-message").textContent = projectRecords.length
        ? projectRecords.length + " project" + (projectRecords.length === 1 ? "" : "s") + " loaded from PostgreSQL."
        : "No projects found in your account yet.";
    } catch (error) {
      byId("projects-message").textContent = error.message + " Check that the backend is running on port 4000.";
      byId("project-rows").innerHTML = '<tr><td colspan="5">Could not load projects.</td></tr>';
    } finally {
      projectRequestBusy = false;
    }
  }

  function resetProjectForm() {
    byId("project-create-form").reset();
    byId("project-submit-btn").textContent = "＋ Create project";
    byId("project-create-form").removeAttribute("data-editing-id");
  }

  byId("project-create-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = byId("project-create-form");
    var editingId = form.getAttribute("data-editing-id");
    var submit = byId("project-submit-btn");
    var message = byId("project-form-message");
    var payload = {
      title: byId("project-title").value.trim(),
      description: byId("project-description").value.trim(),
      status: byId("project-status").value
    };
    if (!payload.title) {
      message.textContent = "Please enter a project name.";
      return;
    }
    submit.disabled = true;
    message.textContent = editingId ? "Updating project…" : "Creating project…";
    try {
      if (editingId) {
        await projectApi("/" + encodeURIComponent(editingId), { method: "PATCH", body: JSON.stringify(payload) });
        message.textContent = "Project updated successfully.";
      } else {
        await projectApi("", { method: "POST", body: JSON.stringify(payload) });
        message.textContent = "Project created successfully.";
      }
      resetProjectForm();
      await loadProjects();
      showToast(editingId ? "Project updated" : "Project created");
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  byId("project-rows").addEventListener("click", async function (event) {
    var editButton = event.target.closest("[data-project-edit]");
    var deleteButton = event.target.closest("[data-project-delete]");
    if (editButton) {
      var selected = projectRecords.find(function (project) { return project.id === editButton.getAttribute("data-project-edit"); });
      if (!selected) return;
      byId("project-title").value = selected.title || "";
      byId("project-description").value = selected.description || "";
      byId("project-status").value = selected.status || "active";
      byId("project-create-form").setAttribute("data-editing-id", selected.id);
      byId("project-submit-btn").textContent = "Save changes";
      byId("project-form-message").textContent = "Editing “" + selected.title + "”. Submit the form to save changes.";
      byId("project-title").focus();
      window.scrollTo(0, 0);
      return;
    }
    if (deleteButton) {
      var id = deleteButton.getAttribute("data-project-delete");
      var project = projectRecords.find(function (item) { return item.id === id; });
      if (!project || !window.confirm('Delete project "' + project.title + '"? This cannot be undone.')) return;
      deleteButton.disabled = true;
      try {
        await projectApi("/" + encodeURIComponent(id), { method: "DELETE" });
        if (byId("project-create-form").getAttribute("data-editing-id") === id) resetProjectForm();
        await loadProjects();
        showToast("Project deleted");
      } catch (error) {
        byId("projects-message").textContent = error.message;
        deleteButton.disabled = false;
      }
    }
  });

  byId("projects-refresh-btn").addEventListener("click", function () {
    loadProjects();
  });

  // Show the real authenticated account instead of hard-coded demo identity labels.
  function applyAuthenticatedIdentity(payload) {
    var user = payload && (payload.user || (payload.data && (payload.data.user || payload.data)) || payload);
    if (!user || typeof user !== "object") return;
    var displayName = String(user.name || user.fullName || user.username || "").trim();
    if (displayName) displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
    var email = String(user.email || "").trim();
    var businessName = String(user.businessName || user.companyName || user.business || displayName || (email ? email.split("@")[0] : "My workspace")).trim();
    var ownerName = displayName || email || "Signed-in user";
    var profileName = byId("profile-page-name");
    var profileEmail = byId("profile-page-email");
    var profileAvatar = byId("profile-page-avatar");
    var sidebarAvatar = document.querySelector(".business-avatar");
    var profileDetailName = byId("profile-detail-name");
    var profileDetailEmail = byId("profile-detail-email");
    if (profileName) profileName.textContent = ownerName;
    if (profileEmail) profileEmail.textContent = email || "No email returned by the account API";
    if (profileAvatar) profileAvatar.textContent = (displayName || email || "U").trim().charAt(0).toUpperCase();
    if (sidebarAvatar) sidebarAvatar.textContent = (displayName || email || "U").trim().charAt(0).toUpperCase();
    if (profileDetailName) profileDetailName.textContent = displayName || "Not provided by account API";
    if (profileDetailEmail) profileDetailEmail.textContent = email || "Not provided by account API";

    // Update only rendered text nodes, so app logic and templates remain untouched.
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var value = node.nodeValue.trim();
      if (value === "Mitti & Loom") node.nodeValue = node.nodeValue.replace(value, businessName);
      else if (value === "Private Demo") node.nodeValue = node.nodeValue.replace(value, "Signed in");
      else if (value === "Arjun Shah") node.nodeValue = node.nodeValue.replace(value, ownerName);
      else if (value === "Demo owner · local only") node.nodeValue = node.nodeValue.replace(value, email || "Authenticated account");
      else if (value === "Fictional demo workspace") node.nodeValue = node.nodeValue.replace(value, "Your workspace");
    });

    // Never leave login credentials in the browser address bar.
    try {
      if (window.location.search) history.replaceState(null, "", window.location.pathname + window.location.hash);
    } catch (error) {}
  }

  async function loadAuthenticatedUser(token) {
    var response = await fetch("http://localhost:4000/api/auth/me", {
      method: "GET",
      headers: { "Authorization": "Bearer " + token }
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error("Session expired");
    applyAuthenticatedIdentity(result);
    var account = result && (result.user || (result.data && (result.data.user || result.data)) || result);
    tourEmail = String(account && account.email || "").trim().toLowerCase();
    return result;
  }

  function showLogin() {
    byId("login-screen").hidden = false;
    byId("app-shell").hidden = true;
    document.body.classList.add("showing-login");
  }

  // First-login guided tour. Only tour completion is stored; no financial values are copied.
  var tourSteps = [
    {page:"overview", target:"#metric-cash", title:"Your cash at a glance", copy:"Start here. Edit Current Cash to match your real opening balance; the dashboard recalculates from your transactions."},
    {page:"overview", target:"#overview-safety-reserve", title:"Protect your reserve", copy:"The reserve is your minimum cash cushion. The overview compares the forecast against it."},
    {page:"overview", target:"#add-transaction-btn", title:"Add a transaction", copy:"Enter a company, description, amount and expected date. Customer confidence is estimated from recorded company outcomes."},
    {page:"transactions", target:"#transactions", title:"Track receipts and payments", copy:"Review forecast transactions, mark completed items and record payment feedback. Future estimates can learn from actual outcomes."},
    {page:"forecast", target:"#cash-chart", title:"Explore the forecast", copy:"Choose a forecast period to see the expected cash path and safety reserve. Receipts are confidence-weighted; scheduled outflows count in full."},
    {page:"forecast", target:"#what-if-input", title:"Try a what-if", copy:"Describe a delayed customer payment or sales change, preview the assumptions and choose whether to apply them."},
    {page:"forecast", target:"#backtest-heading", title:"Check historical coverage", copy:"Import real historical forecast ranges and actual balances to evaluate coverage. No accuracy number is invented."},
    {page:"projects", target:"#projects", title:"Manage projects", copy:"Keep your project records organized in your authenticated workspace."},
    {page:"assistant", target:"#assistant", title:"Local guidance", copy:"The existing private assistant explains cash-flow results using local rules, without sending transaction data to a hosted AI model."},
    {page:"guide", target:"#tour-replay", title:"Replay whenever you want", copy:"The User Guide explains each feature and contains this tour's replay button. You can skip or finish at any time."}
  ];
  var tourIndex = -1;
  var tourEmail = "";
  function tourKey() { return "captidict-tour-v1-" + (tourEmail || "account"); }
  function closeTour(completed) {
    var panel = byId("captidict-tour");
    if (panel) panel.hidden = true;
    document.querySelectorAll(".captidict-tour-target").forEach(function (el) { el.classList.remove("captidict-tour-target"); });
    tourIndex = -1;
    if (completed) { try { localStorage.setItem(tourKey(), "done"); } catch (e) {} }
  }
  function renderTourStep() {
    if (tourIndex < 0) return;
    var step = tourSteps[tourIndex];
    switchPage(step.page, true);
    document.querySelectorAll(".captidict-tour-target").forEach(function (el) { el.classList.remove("captidict-tour-target"); });
    byId("tour-count").textContent = "STEP " + (tourIndex + 1) + " OF " + tourSteps.length;
    byId("tour-title").textContent = step.title;
    byId("tour-copy").textContent = step.copy;
    byId("tour-prev").disabled = tourIndex === 0;
    byId("tour-next").textContent = tourIndex === tourSteps.length - 1 ? "Finish ✓" : "Next →";
    var target = document.querySelector(step.target);
    if (target) { target.classList.add("captidict-tour-target"); target.scrollIntoView({behavior:"smooth",block:"center"}); }
    byId("captidict-tour").hidden = false;
  }
  function startTour(force) {
    if (byId("app-shell").hidden || (!force && localStorage.getItem(tourKey()) === "done")) return;
    tourIndex = 0;
    renderTourStep();
  }
  byId("tour-next").addEventListener("click", function () { if (tourIndex === tourSteps.length - 1) closeTour(true); else { tourIndex++; renderTourStep(); } });
  byId("tour-prev").addEventListener("click", function () { if (tourIndex > 0) { tourIndex--; renderTourStep(); } });
  byId("tour-skip").addEventListener("click", function () { closeTour(true); });
  byId("tour-replay").addEventListener("click", function () { startTour(true); });

  function showWorkspace(page) {
    byId("login-screen").hidden = true;
    byId("app-shell").hidden = false;
    document.body.classList.remove("showing-login");
    setTransactionTab(activeTransactionTab);
    switchPage(page || "overview", false);
    render();
    setTimeout(function () { startTour(false); }, 450);
  }

  function currentScenarioOptions() {
    return {
      delayDays: state.scenario.delayDays,
      extraExpense: state.scenario.extraExpense,
      extraExpenseDate: state.scenario.extraExpenseDate,
      salesDrop: state.scenario.salesDrop,
      supplierShiftDays: state.scenario.supplierShiftDays ? 14 : 0,
      paymentShifts: state.scenario.paymentShifts || {},
      receiptDelays: state.scenario.receiptDelays || {}
    };
  }

  function localAssistantAnswer(question) {
    var text = question.toLowerCase();
    var options = currentScenarioOptions();
    var current = makeSeries(options);
    var low = lowestPoint(current);
    var lowDate = formatDate(toISO(new Date(ANCHOR.getTime() + low.day * 86400000)));
    var gap = RESERVE - low.balance;

    if (/late|delay|customer|receipt|invoice/.test(text)) {
      var customer = state.transactions.filter(function (item) { return item.type === "inflow" && item.status === "forecast"; }).sort(function (a, b) { return b.amount - a.amount; })[0];
      var baseline = lowestPoint(makeSeries({ delayDays: 0, extraExpense: 0, salesDrop: 0, supplierShiftDays: 0 }));
      var delayed = lowestPoint(makeSeries({ delayDays: 10, extraExpense: 0, salesDrop: 0, supplierShiftDays: 0 }));
      var receiptText = customer ? customer.title.split(" · ")[0] + " is the largest pending receipt at " + money(customer.amount) + " with " + Math.round(receiptConfidence(customer) * 100) + "% confidence." : "There are no pending receipts in the current forecast.";
      return receiptText + " In a 10-day delay-only example, the lowest balance changes from " + money(baseline.balance) + " on " + formatDate(toISO(new Date(ANCHOR.getTime() + baseline.day * 86400000))) + " to " + money(delayed.balance) + " on " + formatDate(toISO(new Date(ANCHOR.getTime() + delayed.day * 86400000))) + ". Receipts in the forecast are confidence-weighted.";
    }
    if (/reserve|buffer|safe|shortfall|risk|low|lowest/.test(text)) {
      if (gap > 0) return "The lowest modeled balance is " + money(low.balance) + " on " + lowDate + ", which is " + money(gap) + " below the " + money(RESERVE) + " safety reserve." + (low.balance < 0 ? " The projection also crosses below zero." : "") + " This is a date-based estimate; same-day payments and receipts are netted together.";
      return "The lowest modeled balance is " + money(low.balance) + " on " + lowDate + ", or " + money(-gap) + " above the " + money(RESERVE) + " safety reserve. No negative balance appears in this 30-day view.";
    }
    if (/payment|expense|outflow|spend|payroll|supplier/.test(text)) {
      var totals = scenarioTotals(options);
      var nextPayment = state.transactions.filter(function (item) { return item.type === "outflow" && item.status === "forecast"; }).sort(function (a, b) { return a.date.localeCompare(b.date); })[0];
      return "The forecast includes " + money(totals.out) + " in committed payments" + (totals.extra ? " plus " + money(totals.extra) + " in the scenario expense" : "") + ". " + (nextPayment ? "The next listed payment is " + nextPayment.title + " for " + money(nextPayment.amount) + " on " + formatDate(nextPayment.date) + "." : "There are no planned payments in the current list.") + " Scheduled outflows count at their full amount.";
    }
    if (/action|recommend|improve|what should|extension/.test(text)) {
      var stress = { delayDays: 10, extraExpense: 200000, salesDrop: 40, supplierShiftDays: 0 };
      var stressLow = lowestPoint(makeSeries(stress));
      var responseLow = lowestPoint(makeSeries({ delayDays: 10, extraExpense: 200000, salesDrop: 40, supplierShiftDays: 14 }));
      return "In the sample stress case, the lowest balance is " + money(stressLow.balance) + ". Moving the supplier payment 14 days changes the modeled low to " + money(responseLow.balance) + ". It improves timing in this scenario, but the balance remains below the reserve. This is a comparison only; it does not mean the supplier has agreed.";
    }
    var total = scenarioTotals(options);
    return "Your current local forecast starts at " + money(state.openingCash) + ", includes " + money(total.in) + " in confidence-weighted receipts and " + money(total.out) + " in committed payments, and ends this 30-day view at " + money(current[current.length - 1].balance) + ". Its lowest point is " + money(low.balance) + " on " + lowDate + ".";
  }

  function appendAssistantMessage(role, message) {
    var container = byId("assistant-messages");
    var row = document.createElement("div");
    row.className = "assistant-message " + (role === "user" ? "user-message" : "assistant-response");
    var avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.textContent = role === "user" ? "AS" : "✦";
    var body = document.createElement("div");
    var author = document.createElement("div");
    author.className = "message-author";
    author.textContent = role === "user" ? "You" : "CaptiDict assistant";
    if (role !== "user") {
      var localTag = document.createElement("small");
      localTag.textContent = "LOCAL ANALYSIS";
      author.appendChild(localTag);
    }
    var paragraph = document.createElement("p");
    paragraph.textContent = message;
    body.appendChild(author);
    body.appendChild(paragraph);
    if (role !== "user") {
      var source = document.createElement("small");
      source.className = "message-source";
      source.textContent = "Calculated in this browser · no external request";
      body.appendChild(source);
    }
    row.appendChild(avatar);
    row.appendChild(body);
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function resetAssistantMessages() {
    byId("assistant-messages").innerHTML = '<div class="assistant-message assistant-response"><span class="message-avatar">✦</span><div><div class="message-author">CaptiDict assistant <small>LOCAL ANALYSIS</small></div><p>Ask about your forecast, reserve, upcoming receipts, or payments. I’ll answer from the data saved in this browser.</p><small class="message-source">No external AI request is made.</small></div></div>';
  }

  function openTransactionDialog() {
    var dialog = byId("transaction-dialog");
    var dateInput = document.querySelector('[name="date"]');
    dateInput.min = toISO(ANCHOR);
    dateInput.max = toISO(new Date(ANCHOR.getTime() + 30 * 86400000));
    dateInput.value = "2026-10-29";
    dialog.showModal();
  }

  function openCashDialog() {
    document.querySelector('[name="openingCash"]').value = state.openingCash;
    byId("cash-dialog").showModal();
  }

  async function markTransaction(id) {
    var transaction = state.transactions.find(function (item) { return item.id === id; });
    if (!transaction || transaction.status !== "forecast") return;
    var nextStatus = transaction.type === "inflow" ? "received" : "paid";
    var feedback = null;
    if (transaction.companyName) {
      var choice = window.prompt("Payment outcome for " + transaction.companyName + "\n1 = On time\n2 = Late\n3 = Failed\n4 = Amount mismatch\nCancel = do not change", "1");
      if (choice === null) return;
      var outcomes = { "1": "on_time", "2": "late", "3": "failed", "4": "amount_mismatch" };
      if (!outcomes[choice]) { showToast("Choose 1, 2, 3 or 4"); return; }
      feedback = outcomes[choice];
    }
    try {
      var updated;
      if (feedback) {
        var feedbackResult = await transactionApi("/" + encodeURIComponent(id) + "/feedback", { method: "POST", body: JSON.stringify({ outcome: feedback, actualDate: toISO(new Date()) }) });
        updated = normalizeTransaction(feedbackResult.data);
      } else updated = await updateTransactionOnServer(id, { status: nextStatus });
      if (updated) Object.assign(transaction, updated); else transaction.status = nextStatus;
      if (transaction.status !== "failed" && transaction.type === "inflow") {
        delete state.scenario.receiptDelays[id];
        state.openingCash += Number(transaction.amount);
        showToast("Receipt marked received · saved to database");
      } else if (transaction.status !== "failed") {
        state.openingCash -= Number(transaction.amount);
        showToast("Payment marked paid · saved to database");
      } else showToast("Failed outcome recorded · no cash movement");
      saveState();
      render();
    } catch (error) { showToast("Could not update transaction: " + error.message); }
  }

  async function undoTransaction(id) {
    var transaction = state.transactions.find(function (item) { return item.id === id; });
    if (!transaction || (transaction.status !== "paid" && transaction.status !== "received")) return;
    var previousStatus = transaction.status;
    try {
      var updated = await updateTransactionOnServer(id, { status: "forecast" });
      if (updated) Object.assign(transaction, updated); else transaction.status = "forecast";
      if (previousStatus === "received") {
        state.openingCash -= Number(transaction.amount);
        showToast("Receipt marking undone · saved to database");
      } else {
        state.openingCash += Number(transaction.amount);
        showToast("Payment marking undone · saved to database");
      }
      saveState();
      render();
    } catch (error) { showToast("Could not undo transaction: " + error.message); }
  }

  function exportCSV() {
    var series = makeSeries(state.scenario);
    var lines = [
      ["CaptiDict 30-day cash-flow forecast", "Mitti & Loom"],
      ["Generated", "24 Oct 2026"],
      ["Opening cash INR", state.openingCash],
      ["Safety reserve INR", RESERVE],
      ["Scenario", "Largest receipt delay " + state.scenario.delayDays + " days; named receipt delays " + Object.keys(state.scenario.receiptDelays || {}).map(function (id) { var transaction = state.transactions.find(function (item) { return item.id === id; }); return transaction ? transaction.title + " " + state.scenario.receiptDelays[id] + " days" : ""; }).filter(Boolean).join(", ") + "; surprise expense INR " + state.scenario.extraExpense + "; sales drop " + state.scenario.salesDrop + "%; supplier extension " + state.scenario.supplierShiftDays + " days"],
      [],
      ["Date", "Projected closing cash INR"]
    ];
    series.forEach(function (point) {
      lines.push([toISO(new Date(ANCHOR.getTime() + point.day * 86400000)), Math.round(point.balance)]);
    });
    lines.push([]);
    lines.push(["Transaction", "Type", "Expected date", "Amount INR", "Confidence", "Status", "Delay cost per week INR", "Can discuss date"]);
    state.transactions.forEach(function (transaction) {
      lines.push([transaction.title, transaction.type, transaction.date, transaction.amount, transaction.type === "inflow" ? Math.round(transaction.confidence * 100) + "%" : "Committed", transaction.status, transaction.type === "outflow" && transaction.delayCostPerWeek != null ? transaction.delayCostPerWeek : "", transaction.type === "outflow" && transaction.canDefer ? "Yes" : "No"]);
    });
    var csv = lines.map(function (row) {
      return row.map(function (cell) {
        var text = String(cell == null ? "" : cell).replace(/"/g, '""');
        if (typeof cell === "string" && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text + '"';
      }).join(",");
    }).join("\r\n");
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "captidict-30-day-cash-flow.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    showToast("30-day forecast exported");
  }

  function csvRows(text) {
    var rows = [];
    var row = [];
    var cell = "";
    var quoted = false;
    var input = String(text || "").replace(/^\uFEFF/, "");
    for (var i = 0; i < input.length; i += 1) {
      var char = input[i];
      if (quoted) {
        if (char === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(cell.trim()); cell = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && input[i + 1] === "\n") i += 1;
        row.push(cell.trim());
        if (row.some(function (value) { return value !== ""; })) rows.push(row);
        row = [];
        cell = "";
      } else cell += char;
    }
    if (quoted) throw new Error("CSV has an unclosed quoted value. Check the file and try again.");
    row.push(cell.trim());
    if (row.some(function (value) { return value !== ""; })) rows.push(row);
    return rows;
  }

  function normalizeHeader(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function importDate(value) {
    var raw = String(value || "").trim();
    var match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      var isoDate = match[1] + "-" + String(Number(match[2])).padStart(2, "0") + "-" + String(Number(match[3])).padStart(2, "0");
      var isoParsed = fromISO(isoDate);
      return toISO(isoParsed) === isoDate ? isoDate : "";
    }
    match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match) return "";
    var dateValue = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    if (dateValue.getFullYear() !== Number(match[3]) || dateValue.getMonth() !== Number(match[2]) - 1 || dateValue.getDate() !== Number(match[1])) return "";
    return toISO(dateValue);
  }

  function parseBacktestCSV(text) {
    var rows = csvRows(text);
    var aliases = {
      forecastDate: ["forecastdate", "issueddate", "snapshotdate"],
      targetDate: ["targetdate", "actualdate", "evaluationdate"],
      predictedLow: ["predictedlow", "predictedlowinr", "predictedlower", "lowerbound", "bandlow", "lower"],
      predictedHigh: ["predictedhigh", "predictedhighinr", "predictedupper", "upperbound", "bandhigh", "upper"],
      actualCash: ["actualcash", "actualcashinr", "actualbalance", "cashactual"]
    };
    var headerIndex = -1;
    var columns = {};
    for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      var normalized = rows[rowIndex].map(normalizeHeader);
      var candidate = {};
      Object.keys(aliases).forEach(function (field) {
        candidate[field] = normalized.findIndex(function (header) { return aliases[field].indexOf(header) !== -1; });
      });
      if (Object.keys(candidate).every(function (field) { return candidate[field] >= 0; })) {
        headerIndex = rowIndex;
        columns = candidate;
        break;
      }
    }
    if (headerIndex < 0) throw new Error("Missing required CSV columns. Download the template for the supported headers.");
    var dataRows = rows.slice(headerIndex + 1);
    if (dataRows.length > 5000) throw new Error("This file has more than 5,000 rows. Use a smaller backtest file.");
    var today = toISO(new Date());
    var valid = [];
    var rejected = [];
    var seen = new Set();
    dataRows.forEach(function (values, index) {
      var forecastDate = importDate(values[columns.forecastDate]);
      var targetDate = importDate(values[columns.targetDate]);
      function amountAt(field) {
        var raw = String(values[columns[field]] == null ? "" : values[columns[field]]).trim();
        return raw ? Number(raw.replace(/[₹,\s]/g, "")) : NaN;
      }
      var predictedLow = amountAt("predictedLow");
      var predictedHigh = amountAt("predictedHigh");
      var actualCash = amountAt("actualCash");
      var reason = "";
      if (!forecastDate || !targetDate) reason = "Invalid forecast or target date";
      else if (forecastDate > today || targetDate > today) reason = "Backtest dates must be today or earlier";
      else if (forecastDate > targetDate) reason = "Forecast date must be on or before target date";
      else if (![predictedLow, predictedHigh, actualCash].every(Number.isFinite)) reason = "Predicted bounds and actual cash must be valid INR numbers";
      else if (predictedLow > predictedHigh) reason = "Lower prediction bound exceeds upper bound";
      var key = forecastDate + "|" + targetDate;
      if (!reason && seen.has(key)) reason = "Duplicate forecast and target date pair";
      if (reason) {
        rejected.push("Row " + (headerIndex + index + 2) + ": " + reason);
        return;
      }
      seen.add(key);
      valid.push({ forecastDate: forecastDate, targetDate: targetDate, predictedLow: predictedLow, predictedHigh: predictedHigh, actualCash: actualCash });
    });
    if (!valid.length) throw new Error(rejected[0] || "No observation rows found below the CSV header.");
    valid.sort(function (a, b) { return a.forecastDate.localeCompare(b.forecastDate) || a.targetDate.localeCompare(b.targetDate); });
    var todayDate = fromISO(today);
    var windowStart = toISO(new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() - 180));
    var observations = valid.filter(function (row) { return row.forecastDate >= windowStart && row.forecastDate <= today; });
    var oldestObservation = observations.length ? observations[0].forecastDate : "";
    var latestObservation = observations.length ? observations[observations.length - 1].forecastDate : "";
    var hasWindowStart = valid.some(function (row) { return row.forecastDate <= windowStart; });
    var recentFloor = shiftISO(today, -30);
    var hasRecentSnapshot = Boolean(latestObservation && latestObservation >= recentFloor);
    var qualifies = observations.length >= 20 && hasWindowStart && hasRecentSnapshot;
    return { observations: observations, validCount: valid.length, rejected: rejected, windowStart: windowStart, today: today, oldestObservation: oldestObservation, latestObservation: latestObservation, qualifies: qualifies, hasWindowStart: hasWindowStart, hasRecentSnapshot: hasRecentSnapshot };
  }

  function renderBacktestResult(result) {
    var container = byId("backtest-result");
    var clearButton = byId("clear-backtest-btn");
    clearButton.disabled = !result;
    if (!result) {
      container.innerHTML = '<div class="backtest-empty"><span>i</span><div><strong>Waiting for historical data</strong><p>Use one row per forecast checkpoint: forecast date, target date, lower and upper predicted balance, and actual closing cash. The CSV stays in this browser session.</p></div></div>';
      return;
    }
    if (result.error) {
      container.innerHTML = '<div class="backtest-error"><strong>Could not calculate the backtest.</strong><p>' + escapeHTML(result.error) + '</p></div>';
      return;
    }
    var observations = result.observations;
    if (!observations.length) {
      container.innerHTML = '<div class="backtest-error"><strong>No observations fall in the last 180 days.</strong><p>' + result.validCount + ' valid historical rows were read, but none were issued in the current six-month window.' + (result.rejected.length ? ' ' + result.rejected.length + ' invalid row(s) were skipped.' : '') + '</p></div>';
      return;
    }
    var inside = observations.filter(function (row) { return row.actualCash >= row.predictedLow && row.actualCash <= row.predictedHigh; }).length;
    var coverage = Math.round(inside / observations.length * 100);
    var widths = observations.map(function (row) { return row.predictedHigh - row.predictedLow; }).sort(function (a, b) { return a - b; });
    var middle = Math.floor(widths.length / 2);
    var medianWidth = widths.length % 2 ? widths[middle] : (widths[middle - 1] + widths[middle]) / 2;
    var range = formatDate(result.oldestObservation, true) + " — " + formatDate(result.latestObservation, true);
    var reasons = [];
    if (observations.length < 20) reasons.push("add at least 20 valid observations");
    if (!result.hasWindowStart) reasons.push("include a forecast snapshot at or before the start of the six-month window");
    if (!result.hasRecentSnapshot) reasons.push("include a recent forecast snapshot from the last 30 days");
    var readiness = result.qualifies
      ? "Six-month backtest is ready to report from the uploaded records."
      : "Provisional only — to report six-month coverage, " + reasons.join("; ") + ".";
    var rejectedNote = result.rejected.length ? '<p class="backtest-row-warning">' + result.rejected.length + ' invalid or duplicate row(s) were skipped. First issue: ' + escapeHTML(result.rejected[0]) + '</p>' : "";
    container.innerHTML = '<div class="backtest-metrics"><article class="backtest-metric backtest-coverage"><small>' + (result.qualifies ? 'LAST 6 MONTHS · BAND COVERAGE' : 'PROVISIONAL · UPLOADED OBSERVATIONS') + '</small><strong>' + coverage + '%</strong><span>' + inside + ' of ' + observations.length + ' actual balances inside the band</span></article><article class="backtest-metric"><small>OBSERVATIONS</small><strong>' + observations.length + '</strong><span>valid checkpoints in the window</span></article><article class="backtest-metric"><small>MEDIAN BAND WIDTH</small><strong>' + money(medianWidth) + '</strong><span>lower to upper predicted balance</span></article></div><div class="backtest-status ' + (result.qualifies ? 'ready' : 'provisional') + '"><strong>' + (result.qualifies ? 'Backtest ready' : 'More history needed') + '</strong><span>' + escapeHTML(readiness) + '</span><small>Forecast dates: ' + escapeHTML(range) + ' · Actual data is from the uploaded file.</small></div>' + rejectedNote;
  }

  function downloadBacktestTemplate() {
    var contents = "forecast_date,target_date,predicted_low_inr,predicted_high_inr,actual_cash_inr\r\n";
    var blob = new Blob(["\ufeff" + contents], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "captidict-backtest-template.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Backtest CSV template downloaded");
  }

  function clearBacktestData() {
    backtestResult = null;
    byId("backtest-file").value = "";
    renderBacktestResult(null);
  }

  function transactionFingerprint(item) {
    return [String(item.title || "").trim().toLowerCase(), item.type, item.date, Math.round(Number(item.amount))].join("|");
  }

  function previewCSV(text) {
    var rows = csvRows(text);
    var headerIndex = -1;
    var headers = [];
    var aliases = {
      title: ["transaction", "description", "name", "title", "vendor"],
      type: ["type", "direction", "transactiontype"],
      date: ["expecteddate", "date", "transactiondate"],
      amount: ["amount", "amountinr", "value"],
      confidence: ["confidence", "confidencepercent", "probability"],
      status: ["status", "state"],
      delayCostPerWeek: ["delaycostperweekinr", "delaycostperweek", "delaycostweekinr"],
      canDefer: ["candiscussdate", "cannegotiatedate", "negotiable", "candeferr"]
    };
    for (var r = 0; r < rows.length; r += 1) {
      var candidate = rows[r].map(normalizeHeader);
      if (aliases.title.some(function (alias) { return candidate.indexOf(alias) !== -1; }) && aliases.type.some(function (alias) { return candidate.indexOf(alias) !== -1; }) && aliases.date.some(function (alias) { return candidate.indexOf(alias) !== -1; }) && aliases.amount.some(function (alias) { return candidate.indexOf(alias) !== -1; })) {
        headerIndex = r;
        headers = candidate;
        break;
      }
    }
    if (headerIndex < 0) throw new Error("Could not find columns for description, type, date, and amount. Use the CSV template.");
    function col(field) { return headers.findIndex(function (header) { return aliases[field].indexOf(header) !== -1; }); }
    var columns = { title: col("title"), type: col("type"), date: col("date"), amount: col("amount"), confidence: col("confidence"), status: col("status"), delayCostPerWeek: col("delayCostPerWeek"), canDefer: col("canDefer") };
    var existing = new Set(state.transactions.map(transactionFingerprint));
    var seen = new Set();
    var valid = [];
    var previews = [];
    var duplicateCount = 0;
    var invalidCount = 0;
    var completedCount = 0;
    var dataRows = rows.slice(headerIndex + 1).slice(0, 500);
    dataRows.forEach(function (values) {
      var title = String(values[columns.title] || "").trim();
      var rawType = String(values[columns.type] || "").trim().toLowerCase();
      var date = importDate(values[columns.date]);
      var rawAmount = String(values[columns.amount] || "").replace(/[₹,\s]/g, "");
      var amount = Number(rawAmount);
      var type = ["inflow", "income", "credit", "receipt", "money coming in"].indexOf(rawType) !== -1 ? "inflow" : (["outflow", "expense", "debit", "payment", "money going out"].indexOf(rawType) !== -1 ? "outflow" : "");
      var rawStatus = columns.status >= 0 ? String(values[columns.status] || "forecast").trim().toLowerCase() : "forecast";
      var forecastStatuses = ["forecast", "expected", "planned", "pending", "open", "unpaid", "due"];
      var completedStatuses = ["received", "paid", "settled", "complete", "completed", "reconciled"];
      if (completedStatuses.indexOf(rawStatus) !== -1) {
        completedCount += 1;
        previews.push({ title: title, type: type, date: date, amount: amount, result: "Completed rows skipped" });
        return;
      }
      var reason = forecastStatuses.indexOf(rawStatus) === -1 ? "Status must be forecast, open, or completed" : "";
      if (!title || title.length > 100) reason = "Add a description (max 100 characters)";
      else if (!type) reason = "Type must be inflow or outflow";
      else if (!date) reason = "Date is not valid";
      else if (daysFromAnchor(date) < 0 || daysFromAnchor(date) > 30) reason = "Date must be within the 30-day forecast";
      else if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) reason = "Amount must be a positive INR value";
      var confidence = 1;
      if (type === "inflow" && columns.confidence >= 0 && values[columns.confidence]) {
        var confidenceText = String(values[columns.confidence]).trim();
        var confidenceParsed = Number(confidenceText.replace("%", ""));
        if (confidenceText.indexOf("%") !== -1 || confidenceParsed > 1) confidenceParsed /= 100;
        if (!Number.isFinite(confidenceParsed) || confidenceParsed < 0 || confidenceParsed > 1) reason = "Confidence must be 0–1 or 0–100%";
        else confidence = confidenceParsed;
      }
      var delayCostPerWeek = null;
      if (type === "outflow" && columns.delayCostPerWeek >= 0 && String(values[columns.delayCostPerWeek] || "").trim()) {
        var delayCostText = String(values[columns.delayCostPerWeek]).replace(/[₹,\s]/g, "");
        delayCostPerWeek = Number(delayCostText);
        if (!Number.isFinite(delayCostPerWeek) || delayCostPerWeek < 0) reason = "Delay cost per week must be a non-negative INR value";
      }
      var canDefer = false;
      if (type === "outflow" && columns.canDefer >= 0) {
        var negotiableText = String(values[columns.canDefer] || "").trim().toLowerCase();
        if (["yes", "y", "true", "1"].indexOf(negotiableText) !== -1) canDefer = true;
        else if (negotiableText && ["no", "n", "false", "0"].indexOf(negotiableText) === -1) reason = "Can discuss date must be Yes or No";
      }
      var transaction = { title: title, type: type, date: date, amount: amount, confidence: confidence, delayCostPerWeek: delayCostPerWeek, canDefer: canDefer };
      var fingerprint = transactionFingerprint(transaction);
      if (!reason && (existing.has(fingerprint) || seen.has(fingerprint))) {
        duplicateCount += 1;
        previews.push({ title: title, type: type, date: date, amount: amount, result: "Duplicate · skipped" });
        return;
      }
      if (reason) {
        invalidCount += 1;
        previews.push({ title: title, type: type, date: date, amount: amount, result: reason });
        return;
      }
      seen.add(fingerprint);
      valid.push(transaction);
      previews.push({ title: title, type: type, date: date, amount: amount, result: "Ready to import" });
    });
    return { valid: valid, previews: previews, duplicateCount: duplicateCount, invalidCount: invalidCount, completedCount: completedCount, truncated: rows.length - headerIndex - 1 > 500 };
  }

  function renderImportPreview(result) {
    pendingImportRows = result.valid;
    byId("import-summary").textContent = result.valid.length + " ready · " + result.duplicateCount + " duplicates · " + result.invalidCount + " need correction" + (result.completedCount ? " · " + result.completedCount + " completed rows skipped" : "") + (result.truncated ? " · only the first 500 data rows were reviewed" : "");
    byId("import-preview-rows").innerHTML = result.previews.slice(0, 10).map(function (row) {
      return "<tr><td>" + escapeHTML(row.title || "—") + "</td><td>" + escapeHTML(row.type || "—") + "</td><td>" + escapeHTML(row.date ? formatDate(row.date, true) : "—") + "</td><td>" + (Number.isFinite(row.amount) && row.amount ? money(row.amount) : "—") + "</td><td>" + escapeHTML(row.result) + "</td></tr>";
    }).join("") || '<tr><td colspan="5">No transaction rows found.</td></tr>';
    if (result.previews.length > 10) {
      byId("import-preview-rows").insertAdjacentHTML("beforeend", '<tr><td colspan="5">And ' + (result.previews.length - 10) + ' more row(s). Counts above include all reviewed rows.</td></tr>');
    }
    byId("import-commit-btn").disabled = !pendingImportRows.length;
    byId("import-commit-btn").textContent = pendingImportRows.length ? "Add " + pendingImportRows.length + " valid row" + (pendingImportRows.length === 1 ? "" : "s") : "Add valid rows";
  }

  function downloadCSVTemplate() {
    var contents = 'Description,Type,Date,Amount INR,Confidence,Status,Delay cost per week INR,Can discuss date\r\nCustomer invoice,Inflow,2026-10-29,50000,90%,Forecast,,No\r\nMaterials purchase,Outflow,2026-10-30,25000,100%,Forecast,8500,Yes\r\n';
    var blob = new Blob(["\ufeff" + contents], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "captidict-transaction-template.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function parseLocalWhatIf(input) {
    var text = String(input || "").toLowerCase().replace(/[’]/g, "'");
    var delayMatch = text.match(/\b(\d{1,2})\s*(?:days?|d)\s*(?:late|delayed|delay(?:ed)?|behind)\b/) || text.match(/\b(?:late|delayed|delay(?:ed)?|behind)(?:\s+(?:by|for))?\s*(\d{1,2})\s*(?:days?|d)\b/);
    var delayDays = delayMatch ? Number(delayMatch[1]) : 0;
    if (delayDays > 90) return { error: "Enter a receipt delay of 90 days or less." };

    var salesMatch = text.match(/\b(?:sales|revenue)\b[^.]*?\b(?:drop|fall|decline|decrease|reduce|down|lower)\b[^0-9]{0,20}(\d{1,3})\s*%/) || text.match(/\b(\d{1,3})\s*%\s*(?:drop|lower|decline|decrease)\b[^.]*\b(?:sales|revenue)\b/);
    var salesDrop = salesMatch ? Number(salesMatch[1]) : 0;
    if (salesMatch && salesDrop > 100) return { error: "Sales reduction must be between 0% and 100%." };

    var expenseMatch = text.match(/\b(?:unexpected|extra|one[- ]off|additional)\s+(?:cash\s+)?(?:expense|cost|spend)\b\s*(?:of|is|:)?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|lacs?|lakh|lac|k)?\b/) || text.match(/\b(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|lacs?|lakh|lac|k)?\s+(?:unexpected|extra|one[- ]off|additional)?\s*(?:cash\s+)?(?:expense|cost)\b/);
    var extraExpense = 0;
    if (expenseMatch) {
      var unit = String(expenseMatch[2] || "").toLowerCase();
      var multiplier = /^(?:lakh|lakhs|lac|lacs)$/.test(unit) ? 100000 : (unit === "k" ? 1000 : 1);
      extraExpense = Math.round(Number(expenseMatch[1].replace(/,/g, "")) * multiplier);
      if (!Number.isFinite(extraExpense) || extraExpense > 10000000) return { error: "Keep the unexpected expense at or below ₹1 crore for this demo." };
      if (extraExpense <= 0) return { error: "Enter an unexpected expense greater than zero." };
    }

    if (!delayDays && !salesMatch && !expenseMatch) return { error: "I couldn't find a supported change. Try a customer delay, a sales reduction, or an unexpected expense." };

    var receiptIds = [];
    if (delayDays) {
      var ignoredWords = { the: 1, and: 1, for: 1, by: 1, if: 1, then: 1, what: 1, happens: 1, will: 1, pays: 1, pay: 1, paid: 1, payment: 1, payments: 1, customer: 1, customers: 1, invoice: 1, invoices: 1, receipt: 1, receipts: 1, late: 1, delayed: 1, delay: 1, delays: 1, days: 1, day: 1, sales: 1, sale: 1, revenue: 1, drop: 1, drops: 1, dropped: 1, fall: 1, falls: 1, decline: 1, declines: 1, decrease: 1, reduce: 1, reduced: 1, lower: 1, down: 1, unexpected: 1, extra: 1, expense: 1, cost: 1, spend: 1, one: 1, off: 1, additional: 1, rupees: 1, rs: 1, inr: 1, retail: 1, foods: 1, works: 1, traders: 1, trading: 1, enterprises: 1, enterprise: 1, company: 1, limited: 1, ltd: 1, private: 1, pvt: 1, co: 1 };
      var promptWords = {};
      (text.match(/[a-z0-9]+/g) || []).forEach(function (word) { if (word.length > 2 && !/^\d+$/.test(word) && !ignoredWords[word]) promptWords[word] = true; });
      var pendingReceipts = state.transactions.filter(function (transaction) { return transaction.type === "inflow" && transaction.status === "forecast"; });
      receiptIds = pendingReceipts.filter(function (transaction) {
        var titleWords = transaction.title.toLowerCase().match(/[a-z0-9]+/g) || [];
        return titleWords.some(function (word) { return word.length > 2 && !/^\d+$/.test(word) && !ignoredWords[word] && promptWords[word]; });
      }).map(function (transaction) { return transaction.id; });
      if (!receiptIds.length) {
        var examples = pendingReceipts.map(function (transaction) { return transaction.title.split(" · ")[0]; }).filter(function (name, index, names) { return names.indexOf(name) === index; });
        return { error: "I couldn't match that delay to a pending customer receipt. Use a name from Transactions" + (examples.length ? ", such as " + examples.join(", ") : "") + ". I won't substitute a different customer." };
      }
    }

    return { receiptIds: receiptIds, delayDays: delayDays, salesDrop: salesDrop, extraExpense: extraExpense };
  }

  function invalidateWhatIfPreview() {
    pendingWhatIf = null;
    byId("what-if-preview").hidden = true;
  }

  function showWhatIfPreview(parsed) {
    var preview = byId("what-if-preview");
    var applyButton = byId("what-if-apply");
    preview.hidden = false;
    preview.classList.toggle("is-error", Boolean(parsed.error));
    if (parsed.error) {
      pendingWhatIf = null;
      byId("what-if-preview-title").textContent = "Scenario needs a clearer assumption";
      byId("what-if-preview-copy").textContent = parsed.error;
      applyButton.hidden = true;
      return;
    }

    var assumptions = [];
    if (parsed.delayDays) {
      var affected = parsed.receiptIds.map(function (id) { var transaction = state.transactions.find(function (item) { return item.id === id; }); return transaction ? transaction.title : ""; }).filter(Boolean);
      assumptions.push("Delay " + affected.join(", ") + " by " + parsed.delayDays + " days");
    }
    if (parsed.salesDrop) assumptions.push("reduce forecast sales inflows by " + parsed.salesDrop + "%");
    if (parsed.extraExpense) assumptions.push("add an unexpected outflow of " + money(parsed.extraExpense) + " on " + formatDate(byId("expense-date").value || "2026-11-06"));
    var outsideWindow = parsed.receiptIds.some(function (id) {
      var transaction = state.transactions.find(function (item) { return item.id === id; });
      return transaction && daysFromAnchor(shiftISO(transaction.date, parsed.delayDays)) > 30;
    });
    byId("what-if-preview-title").textContent = "Review before applying";
    byId("what-if-preview-copy").textContent = assumptions.join(" · ") + ". Applying starts a fresh scenario and replaces current what-if settings." + (outsideWindow ? " A delayed receipt beyond this 30-day window will no longer appear in this chart." : " The forecast will use these assumptions and the existing confidence weights.");
    applyButton.hidden = false;
    pendingWhatIf = parsed;
  }

  function applyWhatIfScenario() {
    if (!pendingWhatIf) return;
    var parsed = pendingWhatIf;
    var unavailableReceipt = parsed.receiptIds.some(function (id) {
      return !state.transactions.some(function (transaction) { return transaction.id === id && transaction.type === "inflow" && transaction.status === "forecast"; });
    });
    if (unavailableReceipt) {
      showWhatIfPreview({ error: "A selected receipt is no longer pending. Update the transaction list and preview this scenario again." });
      return;
    }
    state.scenario = {
      delayDays: 0,
      extraExpense: parsed.extraExpense,
      extraExpenseDate: byId("expense-date").value || "2026-11-06",
      salesDrop: parsed.salesDrop,
      supplierShiftDays: 0,
      paymentShifts: {},
      receiptDelays: {},
      whatIfApplied: true
    };
    parsed.receiptIds.forEach(function (id) { state.scenario.receiptDelays[id] = parsed.delayDays; });
    pendingWhatIf = null;
    byId("what-if-preview").hidden = true;
    byId("what-if-input").value = "";
    render();
    showToast("Local what-if applied to the forecast");
  }

  function applyStressScenario() {
    state.scenario.delayDays = 10;
    state.scenario.extraExpense = 200000;
    state.scenario.extraExpenseDate = "2026-11-06";
    state.scenario.salesDrop = 40;
    state.scenario.supplierShiftDays = 0;
    state.scenario.paymentShifts = {};
    state.scenario.receiptDelays = {};
    state.scenario.whatIfApplied = false;
    invalidateWhatIfPreview();
    byId("what-if-input").value = "";
    render();
    showToast("Late-customer stress scenario applied");
  }

  function toggleSupplierMove() {
    invalidateWhatIfPreview();
    state.scenario.supplierShiftDays = state.scenario.supplierShiftDays ? 0 : 14;
    render();
    showToast(state.scenario.supplierShiftDays ? "Supplier extension added to the what-if" : "Supplier extension removed");
  }

  byId("add-transaction-btn").addEventListener("click", openTransactionDialog);
  byId("add-transaction-bottom").addEventListener("click", openTransactionDialog);
  byId("edit-cash-btn").addEventListener("click", openCashDialog);

  // Custom safety reserve setting. Saved per signed-in browser account alongside local workspace state.
  (function installReserveSettings() {
    var cashButton = byId("edit-cash-btn");
    if (cashButton && !byId("edit-reserve-btn")) {
      var reserveButton = document.createElement("button");
      reserveButton.type = "button";
      reserveButton.id = "edit-reserve-btn";
      reserveButton.className = cashButton.className;
      reserveButton.textContent = "Set reserve limit";
      reserveButton.style.marginLeft = "8px";
      cashButton.insertAdjacentElement("afterend", reserveButton);
      reserveButton.addEventListener("click", function () {
        byId("reserve-limit-input").value = String(RESERVE);
        byId("reserve-dialog").showModal();
      });
    }

    if (!byId("reserve-dialog")) {
      var dialog = document.createElement("dialog");
      dialog.id = "reserve-dialog";
      dialog.style.cssText = "border:1px solid #dce7dd;border-radius:16px;padding:24px;max-width:420px;width:calc(100% - 32px);color:#263b2d;box-shadow:0 20px 60px rgba(0,0,0,.2)";
      dialog.innerHTML = '<form id="reserve-form"><h2 style="margin:0 0 8px;font-size:22px">Custom reserve limit</h2><p style="margin:0 0 18px;color:#66756a;font-size:14px">Choose the minimum cash your business should try to keep available. CaptiDict will use this amount in reserve warnings, safe-to-spend estimates, and cash-flow forecasts.</p><label for="reserve-limit-input" style="display:block;font-size:13px;font-weight:650;margin-bottom:6px">Minimum reserve (₹)</label><input id="reserve-limit-input" name="reserveLimit" type="number" min="0" step="500" required style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #cfdacf;border-radius:9px;font:inherit;margin-bottom:18px"><div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" id="cancel-reserve-btn" class="button button-quiet">Cancel</button><button type="submit" class="button button-primary">Save reserve</button></div><p style="font-size:11px;color:#778278;margin:14px 0 0">Saved to this browser for the signed-in workspace. This setting is not yet stored in the backend database.</p></form>';
      document.body.appendChild(dialog);
      dialog.addEventListener("click", function (event) {
        if (event.target === dialog) dialog.close();
      });
      byId("cancel-reserve-btn").addEventListener("click", function () { dialog.close(); });
      byId("reserve-form").addEventListener("submit", function (event) {
        event.preventDefault();
        var input = byId("reserve-limit-input");
        var value = Number(input.value);
        if (input.value.trim() === "" || !Number.isFinite(value) || value < 0) {
          showToast("Enter a valid non-negative reserve limit");
          return;
        }
        state.reserveLimit = value;
        RESERVE = value;
        saveState();
        dialog.close();
        render();
        showToast("Custom reserve limit saved");
      });
    }
  })();
  byId("export-btn").addEventListener("click", exportCSV);
  byId("export-funding-brief").addEventListener("click", exportFundingBrief);
  byId("reset-btn").addEventListener("click", function () {
  invalidateWhatIfPreview();
  byId("what-if-input").value = "";

  state.scenario = {
    delayDays: 0,
    extraExpense: 0,
    extraExpenseDate: "2026-11-06",
    salesDrop: 0,
    supplierShiftDays: 0,
    paymentShifts: {},
    receiptDelays: {},
    whatIfApplied: false
  };

  render();
  showToast("30-day forecast refreshed. Your transactions are unchanged.");
});
  byId("stress-btn").addEventListener("click", applyStressScenario);
  byId("apply-action-btn").addEventListener("click", toggleSupplierMove);
  byId("what-if-form").addEventListener("submit", function (event) {
    event.preventDefault();
    showWhatIfPreview(parseLocalWhatIf(byId("what-if-input").value));
  });
  byId("what-if-input").addEventListener("input", function () {
    invalidateWhatIfPreview();
  });
  byId("what-if-dismiss").addEventListener("click", function () {
    invalidateWhatIfPreview();
  });
  byId("what-if-apply").addEventListener("click", applyWhatIfScenario);
  byId("what-if-clear").addEventListener("click", function () {
    state.scenario = { delayDays: 0, extraExpense: 0, extraExpenseDate: byId("expense-date").value || "2026-11-06", salesDrop: 0, supplierShiftDays: 0, paymentShifts: {}, receiptDelays: {}, whatIfApplied: false };
    byId("what-if-input").value = "";
    invalidateWhatIfPreview();
    render();
    showToast("What-if scenario cleared; base forecast restored");
  });

  var scenarioRenderScheduled = false;
  ["delay-control", "expense-control", "sales-control"].forEach(function (id) {
    byId(id).addEventListener("input", function () {
      invalidateWhatIfPreview();
      if (id === "delay-control") {
        state.scenario.delayDays = Number(this.value);
        state.scenario.receiptDelays = {};
        byId("delay-value").textContent = this.value;
      }
      if (id === "expense-control") {
        state.scenario.extraExpense = Number(this.value);
        byId("expense-value").textContent = new Intl.NumberFormat("en-IN").format(Number(this.value));
      }
      if (id === "sales-control") {
        state.scenario.salesDrop = Number(this.value);
        byId("sales-value").textContent = this.value;
      }
      if (!scenarioRenderScheduled) {
        scenarioRenderScheduled = true;
        window.requestAnimationFrame(function () {
          scenarioRenderScheduled = false;
          render();
        });
      }
    });
  });

  byId("expense-date").addEventListener("change", function () {
    state.scenario.extraExpenseDate = this.value || "2026-11-06";
    render();
  });

  byId("transaction-rows").addEventListener("click", function (event) {
    var deleteButton = event.target.closest("[data-transaction-delete]");
    if (deleteButton) { deleteTransaction(deleteButton.getAttribute("data-transaction-delete")); return; }
    var button = event.target.closest("[data-transaction-action]");
    if (button) markTransaction(button.getAttribute("data-transaction-action"));
  });
  byId("all-transaction-rows").addEventListener("click", function (event) {
    var deleteButton = event.target.closest("[data-transaction-delete]");
    if (deleteButton) { deleteTransaction(deleteButton.getAttribute("data-transaction-delete")); return; }
    var button = event.target.closest("[data-transaction-action]");
    if (button) markTransaction(button.getAttribute("data-transaction-action"));
    var undoButton = event.target.closest("[data-transaction-undo]");
    if (undoButton) undoTransaction(undoButton.getAttribute("data-transaction-undo"));
  });

  var transactionDialog = byId("transaction-dialog");
  transactionDialog.querySelectorAll(".close-dialog").forEach(function (button) {
    button.addEventListener("click", function () {
      transactionDialog.close("cancel");
    });
  });

  byId("transaction-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var formData = new FormData(form);
    var amount = Number(formData.get("amount"));
    var date = String(formData.get("date") || "");
    if (!amount || amount < 1 || !date || daysFromAnchor(date) < 0) {
      showToast("Choose an amount and a date from 24 Oct onwards");
      return;
    }
    var submitButton = form.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      var result = await transactionApi("", { method: "POST", body: JSON.stringify({
        title: String(formData.get("title") || "").trim(),
        type: String(formData.get("type")),
        amount: amount,
        date: date,
        companyName: String(formData.get("companyName") || "").trim(),
        userConfidence: formData.get("userConfidence") === "" ? null : Number(formData.get("userConfidence")),
        status: "forecast",
        key: "custom",
        delayCostPerWeek: null,
        canDefer: false
      }) });
      if (!result || !result.data) throw new Error("The server did not return the saved transaction.");
      state.transactions.push(normalizeTransaction(result.data));
      saveState();
      byId("transaction-dialog").close();
      form.reset();
      render();
      showToast("Saved · automatic confidence " + Math.round(Number(result.data.confidence) * 100) + "%" + (result.estimate && result.estimate.limitedHistory ? " (limited company history)" : ""));
    } catch (error) {
      showToast("Could not save transaction: " + error.message);
    } finally { if (submitButton) submitButton.disabled = false; }
  });

  byId("action-plan-list").addEventListener("change", function (event) {
    var input = event.target.closest("[data-action-toggle]");
    if (!input) return;
    var actionId = input.getAttribute("data-action-toggle");
    state.completedActions = state.completedActions.filter(function (id) { return id !== actionId; });
    if (input.checked) state.completedActions.push(actionId);
    render();
  });

  byId("action-plan-list").addEventListener("click", function (event) {
    var button = event.target.closest("[data-plan-action]");
    if (!button) return;
    var actionId = button.getAttribute("data-plan-action");
    if (actionId === "supplier-extension") {
      switchPage("forecast", true);
      if (!state.scenario.supplierShiftDays) toggleSupplierMove();
    } else {
      switchPage("transactions", true);
    }
  });

  byId("pay-order-planner").addEventListener("change", function (event) {
    var costInput = event.target.closest("[data-pay-cost]");
    var negotiableInput = event.target.closest("[data-pay-negotiable]");
    var input = costInput || negotiableInput;
    if (!input) return;
    var transaction = state.transactions.find(function (item) { return item.id === input.getAttribute(costInput ? "data-pay-cost" : "data-pay-negotiable"); });
    if (!transaction || transaction.type !== "outflow") return;
    if (costInput) {
      var rawCost = costInput.value.trim();
      if (rawCost === "") transaction.delayCostPerWeek = null;
      else {
        var weeklyCost = Number(rawCost);
        if (!Number.isFinite(weeklyCost) || weeklyCost < 0) {
          showToast("Enter a valid non-negative weekly delay-cost estimate");
          return;
        }
        transaction.delayCostPerWeek = weeklyCost;
      }
    } else {
      transaction.canDefer = negotiableInput.checked;
    }
    render();
    showToast("Payment planning assumption saved on this device");
  });

  byId("pay-order-planner").addEventListener("click", function (event) {
    var applyButton = event.target.closest("[data-pay-order-apply]");
    var clearButton = event.target.closest("[data-pay-order-clear]");
    if (applyButton) {
      var plan = calculatePayOrder(currentScenarioOptions());
      if (!plan.deferredIds.length) return;
      state.scenario.paymentShifts = Object.assign({}, state.scenario.paymentShifts || {});
      plan.deferredIds.forEach(function (id) { state.scenario.paymentShifts[id] = 14; });
      render();
      showToast("14-day pay-order comparison applied to the forecast");
    } else if (clearButton) {
      state.scenario.paymentShifts = {};
      render();
      showToast("Applied pay-order moves removed from the forecast");
    }
  });

  byId("import-csv-btn").addEventListener("click", function () {
    pendingImportRows = [];
    byId("import-file").value = "";
    byId("import-summary").textContent = "Choose a CSV file to preview rows.";
    byId("import-preview-rows").innerHTML = '<tr><td colspan="5">No file selected.</td></tr>';
    byId("import-commit-btn").disabled = true;
    byId("import-commit-btn").textContent = "Add valid rows";
    byId("import-dialog").showModal();
  });

  byId("import-file").addEventListener("change", function () {
    var file = this.files && this.files[0];
    pendingImportRows = [];
    byId("import-commit-btn").disabled = true;
    byId("import-preview-rows").innerHTML = '<tr><td colspan="5">Waiting for a valid CSV file.</td></tr>';
    if (!file) return;
    if (file.size > 2000000) {
      byId("import-summary").textContent = "This file is larger than 2 MB. Choose a smaller CSV.";
      return;
    }
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      byId("import-summary").textContent = "Choose a .csv file. Excel workbooks are not supported in this prototype.";
      return;
    }
    byId("import-summary").textContent = "Reading this file on your device…";
    file.text().then(function (contents) {
      try {
        renderImportPreview(previewCSV(contents));
      } catch (error) {
        byId("import-summary").textContent = error.message || "Could not read this CSV. Check the template and try again.";
        byId("import-preview-rows").innerHTML = '<tr><td colspan="5">No rows ready.</td></tr>';
      }
    }).catch(function () {
      byId("import-summary").textContent = "The file could not be read in this browser.";
      byId("import-preview-rows").innerHTML = '<tr><td colspan="5">Could not read this file.</td></tr>';
    });
  });

  byId("download-template-btn").addEventListener("click", downloadCSVTemplate);
  byId("download-backtest-template").addEventListener("click", downloadBacktestTemplate);
  byId("clear-backtest-btn").addEventListener("click", clearBacktestData);
  byId("backtest-file").addEventListener("change", function () {
    var file = this.files && this.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      backtestResult = { error: "Choose a CSV file smaller than 2 MB." };
      renderBacktestResult(backtestResult);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        backtestResult = parseBacktestCSV(String(reader.result || ""));
        renderBacktestResult(backtestResult);
        showToast("Historical forecast coverage calculated locally");
      } catch (error) {
        backtestResult = { error: error.message || "The CSV could not be read." };
        renderBacktestResult(backtestResult);
      }
    };
    reader.onerror = function () {
      backtestResult = { error: "The file could not be read in this browser." };
      renderBacktestResult(backtestResult);
    };
    reader.readAsText(file);
  });
  byId("import-commit-btn").addEventListener("click", function () {
    if (!pendingImportRows.length) return;
    var existing = new Set(state.transactions.map(transactionFingerprint));
    var additions = pendingImportRows.filter(function (item) { return !existing.has(transactionFingerprint(item)); });
    additions.forEach(function (item, index) {
      state.transactions.push({ id: "import-" + Date.now() + "-" + index, title: item.title, type: item.type, amount: item.amount, date: item.date, confidence: item.confidence, status: "forecast", key: "imported", delayCostPerWeek: item.delayCostPerWeek === undefined ? null : item.delayCostPerWeek, canDefer: item.canDefer === true });
    });
    byId("import-dialog").close();
    pendingImportRows = [];
    render();
    showToast(additions.length + " transaction" + (additions.length === 1 ? "" : "s") + " imported locally");
  });

  byId("cash-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var value = Number(new FormData(event.currentTarget).get("openingCash"));
    if (!Number.isFinite(value) || value < 0) {
      showToast("Enter a valid cash balance");
      return;
    }
    state.openingCash = value;
    byId("cash-dialog").close();
    render();
    showToast("Available cash updated");
  });

  document.querySelectorAll("[data-page-link]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      switchPage(link.getAttribute("data-page-link"), true);
    });
  });

  document.querySelectorAll("[data-transaction-tab]").forEach(function (button) {
    button.addEventListener("click", function () {
      setTransactionTab(button.getAttribute("data-transaction-tab"));
    });
    button.addEventListener("keydown", function (event) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      var tabs = Array.from(document.querySelectorAll("[data-transaction-tab]"));
      var index = tabs.indexOf(button);
      var nextIndex = event.key === "Home" ? 0 : (event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length);
      setTransactionTab(tabs[nextIndex].getAttribute("data-transaction-tab"));
      tabs[nextIndex].focus();
    });
  });

  byId("chase-list").addEventListener("click", function (event) {
    var button = event.target.closest("[data-chase-select]");
    if (!button) return;
    selectedChaseId = button.getAttribute("data-chase-select");
    chaseDraftEdited = false;
    renderChaseFeatures(true);
  });

  byId("overview-chase-list").addEventListener("click", function (event) {
    var button = event.target.closest("[data-chase-open]");
    if (button) openReceivables(button.getAttribute("data-chase-open"));
  });

  document.querySelectorAll("[data-chase-tone]").forEach(function (button) {
    button.addEventListener("click", function () {
      selectedChaseTone = button.getAttribute("data-chase-tone");
      chaseDraftEdited = false;
      byId("chase-copy-status").textContent = "Tone changed. Review and edit before using.";
      renderChaseFeatures(true);
    });
  });

  byId("chase-draft-text").addEventListener("input", function () {
    chaseDraftEdited = true;
    byId("chase-copy-status").textContent = "Edited draft. Check details before using.";
  });

  byId("chase-copy-btn").addEventListener("click", async function () {
    var draft = byId("chase-draft-text");
    if (draft.disabled || !draft.value) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(draft.value);
      } else {
        draft.focus();
        draft.select();
        if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
      }
      byId("chase-copy-status").textContent = "Copied. Review it before sending.";
      showToast("Reminder draft copied");
    } catch (error) {
      draft.focus();
      draft.select();
      byId("chase-copy-status").textContent = "Draft selected. Copy it with Ctrl+C.";
    }
  });

  document.querySelectorAll("[data-open-receivables]").forEach(function (button) {
    button.addEventListener("click", function () {
      openReceivables(button.getAttribute("data-chase-open"));
    });
  });

  document.querySelectorAll("[data-guide-target]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      var section = byId(link.getAttribute("data-guide-target"));
      if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  document.querySelectorAll("[data-overview-scenario]").forEach(function (button) {
    button.addEventListener("click", function () {
      invalidateWhatIfPreview();
      var preset = button.getAttribute("data-overview-scenario");
      if (preset === "base") {
        state.scenario = { delayDays: 0, extraExpense: 0, extraExpenseDate: "2026-11-06", salesDrop: 0, supplierShiftDays: 0, paymentShifts: {}, receiptDelays: {} };
      } else {
        state.scenario = {
          delayDays: 10,
          extraExpense: 200000,
          extraExpenseDate: "2026-11-06",
          salesDrop: 40,
          supplierShiftDays: preset === "extension" ? 14 : 0,
          paymentShifts: {},
          receiptDelays: {}
        };
      }
      render();
      showToast(preset === "base" ? "Base forecast selected" : (preset === "extension" ? "Supplier-extension comparison selected" : "Late-customer scenario selected"));
    });
  });

  byId("assistant-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var input = byId("assistant-question");
    var question = input.value.trim();
    if (!question) return;
    appendAssistantMessage("user", question);
    appendAssistantMessage("assistant", localAssistantAnswer(question));
    input.value = "";
    input.focus();
  });

  document.querySelectorAll("[data-prompt]").forEach(function (button) {
    button.addEventListener("click", function () {
      byId("assistant-question").value = button.getAttribute("data-prompt");
      byId("assistant-form").requestSubmit();
    });
  });

  byId("clear-local-data-btn").addEventListener("click", function () {
    if (!window.confirm("Clear the saved demo transactions and restore the fictional sample data on this device?")) return;
    state = copy(initialState);
    clearBacktestData();
    resetAssistantMessages();
    render();
    try { localStorage.removeItem(STORAGE_KEY); } catch (error) {}
    showToast("Saved demo data cleared and sample restored");
  });

  
  var authMode = "login";

  byId("auth-toggle").addEventListener("click", function () {
    authMode = authMode === "login" ? "register" : "login";

    var registering = authMode === "register";
    byId("auth-name").hidden = !registering;
    byId("auth-name-label").hidden = !registering;
    byId("auth-name").required = registering;
    byId("auth-name").autocomplete = "name";
    byId("auth-password").autocomplete = registering
      ? "new-password"
      : "current-password";
    byId("auth-submit").innerHTML = registering
      ? "Create account <span>→</span>"
      : "Log in <span>→</span>";
    byId("auth-toggle").textContent = registering
      ? "Already have an account? Log in"
      : "Need an account? Register";
    byId("auth-message").textContent = "";
  });

  byId("login-form").addEventListener("submit", async function (event) {
    console.log("LOGIN FORM SUBMIT FIRED");
    event.preventDefault();

    var message = byId("auth-message");
    var submit = byId("auth-submit");
    submit.disabled = true;
    message.textContent = "Connecting securely...";

    try {
      var payload = {
        email: byId("auth-email").value.trim(),
        password: byId("auth-password").value
      };

      if (authMode === "register") {
        payload.name = byId("auth-name").value.trim();
      }

      var response = await fetch("http://localhost:4000/api/auth/" + authMode, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      var result = await response.json();
      var authData = result.data || result;

      if (!response.ok) {
      	throw new Error(
     		authData.message ||
    		result.message ||
    		authData.error?.message ||
    		result.error?.message ||
    		"Authentication failed."
  	);
      }

	if (!authData.token) {
  		throw new Error("The server did not return an authentication token.");
	}

      sessionStorage.setItem("srujana-token", authData.token);
      sessionStorage.removeItem("captidict-demo-access");

      message.textContent = "";
      await loadAuthenticatedUser(authData.token);
      await loadTransactionsFromServer();
      showWorkspace("overview");

      try {
        history.replaceState(null, "", window.location.pathname + "#overview");
      } catch (error) {}
    } catch (error) {
      message.textContent = error.message === "Failed to fetch"
        ? "Cannot reach the backend. Make sure the server is running on port 4000."
        : error.message;
    } finally {
      submit.disabled = false;
    }
  });

  function logoutDemo() {
    try {
      sessionStorage.removeItem("captidict-demo-access");
      sessionStorage.removeItem("srujana-token");
    } catch (error) {}

    showLogin();

    try {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (error) {}
  }

  byId("logout-btn").addEventListener("click", logoutDemo);
  byId("logout-top-btn").addEventListener("click", logoutDemo);
  byId("profile-logout-btn").addEventListener("click", logoutDemo);
  byId("privacy-logout-btn").addEventListener("click", logoutDemo);
  byId("profile-replay-tour").addEventListener("click", function () {
    switchPage("overview", true);
    startTour(true);
  });

  // Secure password change: credentials are sent only to the authenticated backend endpoint.
  byId("change-password-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var message = byId("profile-security-message");
    var submit = byId("profile-change-password-submit");
    var currentPassword = byId("profile-current-password").value;
    var newPassword = byId("profile-new-password").value;
    var confirmPassword = byId("profile-confirm-password").value;
    var token = sessionStorage.getItem("srujana-token");

    message.hidden = false;
    message.removeAttribute("data-kind");
    if (!token) {
      message.dataset.kind = "error";
      message.textContent = "Your session has expired. Please sign in again.";
      return;
    }
    if (newPassword.length < 10 || newPassword.length > 72) {
      message.dataset.kind = "error";
      message.textContent = "Your new password must be between 10 and 72 characters.";
      return;
    }
    if (newPassword !== confirmPassword) {
      message.dataset.kind = "error";
      message.textContent = "The new password and confirmation do not match.";
      byId("profile-confirm-password").focus();
      return;
    }
    if (currentPassword === newPassword) {
      message.dataset.kind = "error";
      message.textContent = "Choose a new password different from your current password.";
      return;
    }

    submit.disabled = true;
    message.textContent = "Updating your password…";
    try {
      var response = await fetch("http://localhost:4000/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword })
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        var errorMessage = result?.error?.message || result?.message || result?.data?.message || "Could not change your password. Please try again.";
        throw new Error(errorMessage);
      }
      message.dataset.kind = "success";
      message.textContent = result?.data?.message || result?.message || "Password changed successfully.";
      form.reset();
    } catch (error) {
      message.dataset.kind = "error";
      message.textContent = error.message === "Failed to fetch"
        ? "Cannot reach the backend. Make sure it is running on port 4000."
        : error.message;
    } finally {
      submit.disabled = false;
    }
  });



 
  var forecastHorizonSelect = byId("forecast-horizon");
  if (forecastHorizonSelect) {
    forecastHorizonSelect.addEventListener("change", function () {
      var nextHorizon = Number(forecastHorizonSelect.value);
      if ([30, 90, 180, 365].indexOf(nextHorizon) === -1) return;
      forecastHorizonDays = nextHorizon;
      render();
    });
  }

  var savedToken = sessionStorage.getItem("srujana-token");

  if (savedToken) {
    loadAuthenticatedUser(savedToken)
      .then(async function () {
        await loadTransactionsFromServer();

        var requestedPage = window.location.hash.slice(1);
        showWorkspace(
          pageDetails[requestedPage] ? requestedPage : "overview"
        );
      })
      .catch(function () {
        sessionStorage.removeItem("srujana-token");
        sessionStorage.removeItem("captidict-demo-access");
        showLogin();
        history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search
        );
      });
  } else {
    showLogin();
  }
})();