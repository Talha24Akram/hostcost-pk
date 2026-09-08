(function () {
  "use strict";

  const el = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const money = (value) => `$${Number(value).toFixed(2)}`;
  const signedMoney = (value) => `${value >= 0 ? "+" : "-"}${money(Math.abs(value))}`;
  const percent = (value) => `${value >= 0 ? "+" : ""}${Number(value).toFixed(0)}%`;
  const pkr = (value, fx) => `PKR ${Math.round(value * fx).toLocaleString("en-PK")}`;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const limits = {
    sites: [1, 500],
    traffic: [1, 100000],
    storage: [1, 10000],
    hourly: [0, 500],
    fx: [1, 1000],
    vat: [0, 50]
  };
  const validProfiles = ["budget", "speed", "control", "agency"];
  const config = window.PARTNER_CONFIG || {};
  let catalog;

  window.dataLayer = window.dataLayer || [];
  function track(event, payload) {
    window.dataLayer.push({ event, ...payload, ts: new Date().toISOString() });
  }

  function getInputs() {
    return {
      sites: clamp(number(el("sites").value), ...limits.sites),
      traffic: clamp(number(el("traffic").value), ...limits.traffic),
      storage: clamp(number(el("storage").value), ...limits.storage),
      hourly: clamp(number(el("hourly").value), ...limits.hourly),
      fx: clamp(number(el("fx").value), ...limits.fx),
      vat: clamp(number(el("vat").value), ...limits.vat),
      term: el("term").value,
      profile: el("profile").value,
      premiumBackup: el("premium-backup").checked
    };
  }

  function setInputs(input) {
    const values = { ...getInputs(), ...input };
    ["sites", "traffic", "storage", "hourly", "fx", "vat"].forEach((id) => {
      el(id).value = clamp(number(values[id]), ...limits[id]);
    });
    if (["promo", "renewal"].includes(values.term)) el("term").value = values.term;
    if (validProfiles.includes(values.profile)) el("profile").value = values.profile;
    el("premium-backup").checked = Boolean(values.premiumBackup);
  }

  function readSharedInputs() {
    const query = new URLSearchParams(window.location.search);
    const keys = Object.keys(limits).concat(["term", "profile", "backup"]);
    if (!keys.some((key) => query.has(key))) return null;
    const values = getInputs();
    Object.keys(limits).forEach((id) => {
      if (query.has(id)) values[id] = clamp(number(query.get(id)), ...limits[id]);
    });
    if (["promo", "renewal"].includes(query.get("term"))) values.term = query.get("term");
    if (validProfiles.includes(query.get("profile"))) values.profile = query.get("profile");
    if (query.has("backup")) values.premiumBackup = query.get("backup") === "1";
    return values;
  }

  function buildPartnerUrl(key) {
    const partner = config[key] || {};
    const id = String(partner.affiliateId || "").trim();
    if (id && partner.trackingTemplate) return partner.trackingTemplate.replace("{id}", encodeURIComponent(id));
    return partner.baseUrl || "#";
  }

  function score(plan, input, monthlyCost) {
    const scores = plan.scores;
    const weights = {
      budget: { budget: .52, speed: .14, control: .14, resilience: .20 },
      speed: { budget: .20, speed: .45, control: .10, resilience: .25 },
      control: { budget: .16, speed: .10, control: .55, resilience: .19 },
      agency: { budget: .29, speed: .25, control: .22, resilience: .24 }
    }[input.profile];
    const maxCost = 100;
    const costScore = clamp(5 - (monthlyCost / maxCost) * 3.5, 1, 5);
    return Math.round((costScore * weights.budget + scores.speed * weights.speed + scores.control * weights.control + scores.resilience * weights.resilience) * 20);
  }

  function backupCost(plan, input, units) {
    if (!input.premiumBackup) return 0;
    if (Number.isFinite(plan.backupRatePerGb)) return plan.backupRatePerGb * input.storage * units;
    return number(plan.backupAddOn) * units;
  }

  function calculate(plan, input) {
    const selectedUnitPrice = input.term === "renewal" ? plan.renewalMonthly : plan.promoMonthly;
    const units = Math.max(1, Math.ceil(input.sites / plan.includedSites));
    const selectedBase = selectedUnitPrice * units;
    const promoBase = plan.promoMonthly * units;
    const renewalBase = plan.renewalMonthly * units;
    const backup = backupCost(plan, input, units);
    const admin = plan.adminHours * input.hourly;
    const selectedTax = (selectedBase + backup + admin) * (input.vat / 100);
    const promoTax = (promoBase + backup + admin) * (input.vat / 100);
    const renewalTax = (renewalBase + backup + admin) * (input.vat / 100);
    const monthly = selectedBase + backup + admin + selectedTax;
    const firstYear = promoBase * 12 + backup * 12 + admin * 12 + promoTax * 12 + plan.setupHours * input.hourly;
    const renewalYear = renewalBase * 12 + backup * 12 + admin * 12 + renewalTax * 12;
    const commitmentMonths = Math.max(1, number(plan.promoTermMonths) || 12);
    const upfrontProvider = (promoBase + backup) * commitmentMonths * (1 + input.vat / 100);
    const capacity = [];
    if (Number.isFinite(plan.storageGb) && input.storage > plan.storageGb) capacity.push(`Storage ${input.storage}GB > ${plan.storageGb}GB reference tier`);
    if (Number.isFinite(plan.trafficGb) && input.traffic > plan.trafficGb) capacity.push(`Traffic ${input.traffic}GB > ${plan.trafficGb}GB reference tier`);
    if (input.sites > plan.includedSites) capacity.push(`${input.sites} sites may need ${units} plan units`);
    return {
      ...plan,
      monthly,
      firstYear,
      renewalYear,
      upfrontProvider,
      renewalUplift: renewalYear - firstYear,
      renewalUpliftPct: firstYear ? ((renewalYear - firstYear) / firstYear) * 100 : 0,
      costPerSite: renewalYear / 12 / input.sites,
      score: score(plan, input, monthly),
      capacity
    };
  }

  function envelope(plan) {
    const storage = plan.storageLabel || `${plan.storageGb}GB storage`;
    const traffic = plan.trafficLabel || (Number.isFinite(plan.trafficGb) ? `${plan.trafficGb}GB traffic` : "capacity not published");
    return `${storage} / ${traffic}`;
  }

  function siteCapacity(plan) {
    return plan.includedSitesLabel || `${plan.includedSites} modeled site slots`;
  }

  function renderResults(input) {
    const ranked = catalog.plans.map((plan) => calculate(plan, input)).sort((a, b) => b.score - a.score || a.monthly - b.monthly);
    const top = ranked[0];
    const capacityStatus = top.capacity.length ? "Needs capacity review" : "Within reference envelope";
    el("results-summary").textContent = `${input.sites} site${input.sites === 1 ? "" : "s"} • ${input.traffic}GB traffic • ${input.storage}GB storage • ${input.term === "renewal" ? "renewal lens" : "intro lens"}`;
    el("recommendation").innerHTML = `<strong>Best fit for this profile: ${top.provider}.</strong><span>${top.fit} ${top.priceBasis} Verify the final plan envelope before checkout.</span>`;
    el("results-metrics").innerHTML = `
      <article class="metric-card"><small>Year-2 renewal</small><strong>${money(top.renewalYear)}</strong><span>${pkr(top.renewalYear, input.fx)} / year</span></article>
      <article class="metric-card"><small>Renewal impact</small><strong>${percent(top.renewalUpliftPct)}</strong><span>${signedMoney(top.renewalUplift)} vs first-year model</span></article>
      <article class="metric-card"><small>Cost per requested site</small><strong>${money(top.costPerSite)}</strong><span>${pkr(top.costPerSite, input.fx)} / month at renewal</span></article>
      <article class="metric-card"><small>Capacity signal</small><strong>${capacityStatus}</strong><span>${siteCapacity(top)}</span></article>`;
    el("results-grid").innerHTML = ranked.map((plan, index) => {
      const partner = config[plan.affiliateKey] || {};
      const approved = Boolean(String(partner.affiliateId || "").trim());
      const rel = approved ? "sponsored nofollow noopener" : "noopener";
      const cta = approved ? "See partner offer ↗" : "Open official pricing ↗";
      const warn = plan.capacity.length ? `<p class="capacity-warn">⚠ ${plan.capacity.join(" • ")}</p>` : `<p class="capacity-ok">✓ Within the displayed reference envelope</p>`;
      const backupCopy = input.premiumBackup ? `Backup model: ${plan.backupLabel}` : "Backup buffer off; inclusion varies by provider.";
      return `<article class="result-card ${index === 0 ? "is-top" : ""}">
        <span class="fit-tag ${index === 0 ? "" : "neutral"}">${index === 0 ? "TOP MATCH" : `FIT ${plan.score}/100`}</span>
        <h3>${plan.provider}</h3>
        <p class="plan-name">${plan.plan}</p>
        <div class="cost-line"><strong>${money(plan.monthly)}</strong><span>/ month</span></div>
        <p class="cost-pkr">${pkr(plan.monthly, input.fx)} at your FX input</p>
        <ul class="metric-list">
          <li><span>First-year TCO</span><b>${money(plan.firstYear)}</b></li>
          <li><span>Year-2 TCO</span><b>${money(plan.renewalYear)}</b></li>
          <li><span>Renewal change</span><b>${percent(plan.renewalUpliftPct)}</b></li>
          <li><span>Intro provider commitment</span><b>${money(plan.upfrontProvider)}</b></li>
          <li><span>Reference envelope</span><b>${envelope(plan)}</b></li>
          <li><span>Admin assumption</span><b>${plan.adminHours}h/mo</b></li>
        </ul>
        <p class="fit-copy">${plan.fit}</p>
        ${warn}
        <p class="watch-copy"><strong>Watch:</strong> ${plan.watch}</p>
        <p class="backup-copy">${backupCopy}</p>
        <p class="source-copy"><a href="${plan.priceSource}" target="_blank" rel="noopener">Price source ↗</a><a href="${plan.payoutSource}" target="_blank" rel="noopener">Payout evidence ↗</a></p>
        <a class="outbound-link" href="${buildPartnerUrl(plan.affiliateKey)}" target="_blank" rel="${rel}" data-analytics-event="outbound_click" data-partner="${plan.provider}"><span>${cta}</span><span>↗</span></a>
      </article>`;
    }).join("");
    track("calculator_result", { profile: input.profile, term: input.term, recommended: top.provider });
    return { ranked, top };
  }

  function renderPresets() {
    el("preset-row").innerHTML = catalog.presets.map((preset) => `<button class="preset-button" type="button" data-preset="${preset.id}"><strong>${preset.label}</strong><span>${preset.description}</span></button>`).join("");
  }

  function renderSignals() {
    el("signals-grid").innerHTML = catalog.marketSignals.map((signal) => `<article class="signal"><small>${signal.label}</small><p>${signal.value}</p><a href="${signal.source}" target="_blank" rel="noopener">Read the source ↗</a></article>`).join("");
    el("last-verified").textContent = catalog.lastVerified;
    el("last-verified").setAttribute("datetime", catalog.lastVerified);
    el("model-note").textContent = catalog.modelNote;
    el("partner-list").innerHTML = catalog.plans.map((plan) => `<div class="partner-row"><div><strong>${plan.provider}</strong><span>${plan.commission} · ${plan.payout}</span></div><div class="partner-status"><span>${plan.payoutFit}</span><a href="${plan.payoutSource}" target="_blank" rel="noopener">Source ↗</a></div></div>`).join("");
  }

  function shareUrl(input) {
    const params = new URLSearchParams({
      sites: input.sites,
      traffic: input.traffic,
      storage: input.storage,
      hourly: input.hourly,
      fx: input.fx,
      vat: input.vat,
      term: input.term,
      profile: input.profile,
      backup: input.premiumBackup ? "1" : "0"
    });
    return `${window.location.origin}${window.location.pathname}?${params.toString()}#results`;
  }

  function setActionStatus(message) {
    el("action-status").textContent = message;
  }

  async function shareResults() {
    const input = getInputs();
    const url = shareUrl(input);
    const text = "My HostCost PK hosting shortlist";
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "HostCost PK shortlist", text, url });
        setActionStatus("Share sheet opened.");
        track("share_result", { method: "native_share" });
      } catch (_) {
        // A cancelled share is not an error worth surfacing.
      }
      return;
    }
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(url);
        setActionStatus("Shortlist link copied.");
        track("share_result", { method: "clipboard" });
        return;
      } catch (_) {
        // Fall through to a manual copy prompt.
      }
    }
    window.prompt("Copy this shortlist link:", url);
    setActionStatus("Share link ready to copy.");
    track("share_result", { method: "manual" });
  }

  async function start() {
    try {
      const response = await fetch("./catalog.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`catalog ${response.status}`);
      catalog = await response.json();
      const shared = readSharedInputs();
      if (shared) setInputs(shared);
      renderPresets();
      renderSignals();
      renderResults(getInputs());
    } catch (error) {
      el("results-grid").innerHTML = `<div class="signal"><p>Catalog could not load. Refresh the page or check the static deployment.</p><small>${String(error.message || error)}</small></div>`;
    }
  }

  el("cost-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (catalog) renderResults(getInputs());
    track("calculator_submit", getInputs());
  });
  el("share-result").addEventListener("click", shareResults);
  document.addEventListener("click", (event) => {
    const presetButton = event.target.closest("[data-preset]");
    if (presetButton && catalog) {
      const preset = catalog.presets.find((item) => item.id === presetButton.dataset.preset);
      if (preset) {
        setInputs(preset.values);
        renderResults(getInputs());
        setActionStatus(`${preset.label} loaded.`);
        track("preset_selected", { preset: preset.id });
      }
    }
    const link = event.target.closest("[data-analytics-event]");
    if (link) track(link.dataset.analyticsEvent, { partner: link.dataset.partner || "unknown" });
  });

  function registerWebMcp() {
    const context = document.modelContext;
    if (!context || typeof context.registerTool !== "function") return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "calculate_hosting_tco",
        title: "Calculate hosting TCO",
        description: "Apply a hosting profile to the visible calculator and return the ranked shortlist with first-year, renewal-aware and cost-per-site estimates.",
        inputSchema: {
          type: "object",
          properties: {
            sites: { type: "number", minimum: 1, maximum: 500 },
            traffic: { type: "number", minimum: 1, maximum: 100000 },
            storage: { type: "number", minimum: 1, maximum: 10000 },
            hourly: { type: "number", minimum: 0, maximum: 500 },
            fx: { type: "number", minimum: 1, maximum: 1000 },
            vat: { type: "number", minimum: 0, maximum: 50 },
            term: { type: "string", enum: ["promo", "renewal"] },
            profile: { type: "string", enum: validProfiles },
            premiumBackup: { type: "boolean" }
          },
          required: ["sites", "traffic", "storage", "hourly", "fx", "vat", "term", "profile"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!catalog || !input || typeof input !== "object") throw new Error("Calculator catalog is not ready");
          const values = {
            sites: clamp(number(input.sites), ...limits.sites),
            traffic: clamp(number(input.traffic), ...limits.traffic),
            storage: clamp(number(input.storage), ...limits.storage),
            hourly: clamp(number(input.hourly), ...limits.hourly),
            fx: clamp(number(input.fx), ...limits.fx),
            vat: clamp(number(input.vat), ...limits.vat),
            term: input.term === "promo" ? "promo" : "renewal",
            profile: validProfiles.includes(input.profile) ? input.profile : "speed",
            premiumBackup: Boolean(input.premiumBackup)
          };
          setInputs(values);
          const result = renderResults(values);
          return {
            recommended: result.top.provider,
            score: result.top.score,
            monthlyUsd: Number(result.top.monthly.toFixed(2)),
            firstYearUsd: Number(result.top.firstYear.toFixed(2)),
            renewalYearUsd: Number(result.top.renewalYear.toFixed(2)),
            renewalUpliftPct: Number(result.top.renewalUpliftPct.toFixed(1)),
            costPerSiteUsd: Number(result.top.costPerSite.toFixed(2)),
            upfrontProviderUsd: Number(result.top.upfrontProvider.toFixed(2)),
            visibleStateUpdated: true
          };
        }
      }, { signal: lifecycle.signal })).catch(() => {});
    } catch (_) {
      // Unsupported or partially implemented browser contexts may ignore this optional surface.
    }
  }

  ["sites", "traffic", "storage", "hourly", "fx", "vat", "term", "profile", "premium-backup"].forEach((id) => {
    el(id).addEventListener("change", () => { if (catalog) renderResults(getInputs()); });
  });
  registerWebMcp();
  start();
})();
