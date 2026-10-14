#!/usr/bin/env node
// Benchmark helper for multi-agent systems. Node 18 or later, no packages.
//   init <system-root>                               find or create the system's standard, list what exists
//   validate --run <run-dir> [--plan-only]           check plan, seams, records, and grades (--plan-only: before any trial)
//   report --run <run-dir> [--previous <run-dir>]    validate, aggregate, write results.json and REPORT.md
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultStandardPath = path.join(skillDir, "assets", "standard.default.json");
const builtInSections = ["summary", "configurations", "end_to_end", "seams", "comparison", "observations", "recommendations", "method"];
const seamKinds = ["agent", "stage", "end_to_end"];
const statuses = ["ok", "failed", "timeout"];
const tokenFields = ["input", "output", "cache_read", "cache_write"];
const publishModes = ["pr", "commit", "none"];
const isolationModes = ["isolated", "attributed"];
// Free-form maps in the standard: their keys are model names or section names, not settings.
const freeFormKeys = new Set(["pricing_usd_per_million_tokens"]);

function die(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) die(`${label} not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    die(`${label} is not valid JSON (${file}): ${e.message}`);
  }
}

function readJsonl(file, label, errors) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push({ ...JSON.parse(line), _line: i + 1 });
    } catch (e) {
      errors.push(`${label} line ${i + 1}: not valid JSON (${e.message})`);
    }
  });
  return rows;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

function unknownKeys(def, user, prefix = "") {
  const found = [];
  for (const [k, v] of Object.entries(user)) {
    if (k.startsWith("_")) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (!(k in def)) found.push(key);
    else if (isObject(def[k]) && isObject(v) && !freeFormKeys.has(k)) found.push(...unknownKeys(def[k], v, key));
  }
  return found;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) opts._.push(argv[i]);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts[argv[i].slice(2)] = argv[++i];
    else opts[argv[i].slice(2)] = true;
  }
  return opts;
}

function shortCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "nocommit";
  }
}

function suggestedRunId(root) {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z-${shortCommit(root)}`;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function loadStandard(benchDir) {
  const defaults = readJson(defaultStandardPath, "Default standard");
  const file = path.join(benchDir, "standard.json");
  const user = fs.existsSync(file) ? readJson(file, "Standard") : {};
  const standard = merge(defaults, user);
  const warnings = unknownKeys(defaults, user).map((k) => `Unknown key '${k}' in .benchmark/standard.json (typo?). It is ignored.`);
  const errors = [];
  for (const k of ["seam", "end_to_end"]) if (!isPositiveInt(standard.trials[k])) errors.push(`standard.trials.${k} must be a positive integer.`);
  for (const [k, v] of Object.entries(standard.thresholds)) if (typeof v !== "number" || v < 0) errors.push(`standard.thresholds.${k} must be a number >= 0.`);
  if (!Array.isArray(standard.report.sections) || !standard.report.sections.every((s) => typeof s === "string"))
    errors.push("standard.report.sections must be an array of section names.");
  if (!publishModes.includes(standard.publish.mode)) errors.push(`standard.publish.mode must be one of ${publishModes.join(", ")}.`);
  for (const [model, p] of Object.entries(standard.pricing_usd_per_million_tokens)) {
    if (!isObject(p) || typeof p.input !== "number" || typeof p.output !== "number")
      errors.push(`standard.pricing_usd_per_million_tokens.${model} needs numeric 'input' and 'output' (cache_read and cache_write are optional).`);
  }
  if (errors.length) die(`Standard has problems (${file}):\n- ${errors.join("\n- ")}`);
  return { standard, file, warnings };
}

function describeStandard(standard) {
  const priced = Object.keys(standard.pricing_usd_per_million_tokens);
  console.log(`  system: ${standard.system || "(unnamed)"}`);
  console.log(`  trials: ${standard.trials.seam} per seam, ${standard.trials.end_to_end} per end-to-end workflow, per configuration`);
  console.log(`  report sections: ${standard.report.sections.join(", ")}`);
  console.log(`  priced models: ${priced.length ? priced.join(", ") : "none. Look for a pricing table in the system's own config, or ask the user; without prices cost is reported only where the system records it"}`);
  console.log(`  publish: ${standard.publish.mode}`);
}

function init(root) {
  if (!root) die("Usage: init <system-root>");
  if (!fs.existsSync(root)) die(`System root not found: ${root}`);
  const benchDir = path.join(root, ".benchmark");
  const file = path.join(benchDir, "standard.json");
  if (fs.existsSync(file)) {
    const { standard, warnings } = loadStandard(benchDir);
    console.log(`Using the existing standard: ${file}`);
    describeStandard(standard);
    for (const w of warnings) console.log(`Warning: ${w}`);
  } else {
    fs.mkdirSync(benchDir, { recursive: true });
    const standard = readJson(defaultStandardPath, "Default standard");
    standard.system = path.basename(path.resolve(root));
    fs.writeFileSync(file, JSON.stringify(standard, null, 2) + "\n");
    console.log(`No standard existed for this system. Created ${file} from the default.`);
    describeStandard(standard);
  }
  const seamsFile = path.join(benchDir, "seams.json");
  if (fs.existsSync(seamsFile)) {
    const seams = readJson(seamsFile, "Seam catalog").seams ?? [];
    console.log(`Seam catalog: ${seams.length} seams (${seams.map((s) => s.id).join(", ")})`);
  } else {
    console.log("Seam catalog: none yet (.benchmark/seams.json)");
  }
  const runsDir = path.join(benchDir, "runs");
  const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => fs.statSync(path.join(runsDir, d)).isDirectory()).sort() : [];
  if (runs.length) {
    console.log(`Previous runs (latest last):`);
    for (const r of runs.slice(-5)) console.log(`  ${r}${fs.existsSync(path.join(runsDir, r, "results.json")) ? "" : " (no report)"}`);
  } else {
    console.log("Previous runs: none");
  }
  console.log(`Suggested run id: ${suggestedRunId(root)}[-<label>]`);
}

function runContext(runArg) {
  if (!runArg) die("Missing --run <run-dir>.");
  const runDir = path.resolve(runArg);
  if (!fs.existsSync(runDir)) die(`Run directory not found: ${runDir}`);
  if (path.basename(path.dirname(runDir)) !== "runs") die(`Run directory must be .benchmark/runs/<run-id>, got ${runDir}`);
  return { runDir, benchDir: path.dirname(path.dirname(runDir)) };
}

function load(ctx, { withNarrative, planOnly = false }) {
  const errors = [];
  const { standard, file: standardFile, warnings } = loadStandard(ctx.benchDir);
  const catalog = readJson(path.join(ctx.benchDir, "seams.json"), "Seam catalog");
  const plan = readJson(path.join(ctx.runDir, "plan.json"), "Run plan");
  const records = planOnly ? [] : readJsonl(path.join(ctx.runDir, "records.jsonl"), "records.jsonl", errors);
  const grades = planOnly ? [] : readJsonl(path.join(ctx.runDir, "grades.jsonl"), "grades.jsonl", errors);
  const narrativeFile = path.join(ctx.runDir, "narrative.json");
  const narrative = withNarrative ? readJson(narrativeFile, "Narrative") : null;

  const seams = new Map();
  if (!Array.isArray(catalog.seams) || !catalog.seams.length) errors.push("seams.json: 'seams' must be a non-empty array.");
  for (const [i, s] of (catalog.seams ?? []).entries()) {
    const where = `seams.json seam ${s.id ?? `#${i + 1}`}`;
    if (typeof s.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) errors.push(`${where}: 'id' must be lowercase letters, digits, and hyphens.`);
    else if (seams.has(s.id)) errors.push(`${where}: duplicate id.`);
    if (!seamKinds.includes(s.kind)) errors.push(`${where}: 'kind' must be one of ${seamKinds.join(", ")}.`);
    if (s.isolation !== undefined && !isolationModes.includes(s.isolation)) errors.push(`${where}: 'isolation' must be one of ${isolationModes.join(", ")}.`);
    if (s.isolation === "attributed" && !(typeof s.attributed_from === "string" && s.attributed_from))
      errors.push(`${where}: an attributed seam needs 'attributed_from', the id of the seam whose runs it is measured inside.`);
    if (!Array.isArray(s.quality) || !s.quality.length) errors.push(`${where}: 'quality' needs at least one measure.`);
    const names = new Set();
    for (const m of s.quality ?? []) {
      if (typeof m.name !== "string" || !m.name) errors.push(`${where}: every quality measure needs a 'name'.`);
      else if (names.has(m.name)) errors.push(`${where}: duplicate quality measure '${m.name}'.`);
      names.add(m.name);
      if (m.weight !== undefined && !(typeof m.weight === "number" && m.weight > 0)) errors.push(`${where}: measure '${m.name}' weight must be a number > 0.`);
    }
    if (typeof s.id === "string") seams.set(s.id, s);
  }
  for (const s of seams.values())
    if (s.isolation === "attributed" && s.attributed_from && !seams.has(s.attributed_from)) errors.push(`seams.json seam ${s.id}: attributed_from '${s.attributed_from}' is not a seam id.`);

  if (typeof plan.run_id !== "string" || !plan.run_id) errors.push("plan.json: 'run_id' is required.");
  else if (plan.run_id !== path.basename(ctx.runDir)) errors.push(`plan.json: run_id '${plan.run_id}' does not match the folder name '${path.basename(ctx.runDir)}'.`);
  const configs = Array.isArray(plan.configs) ? plan.configs : [];
  if (!configs.length) errors.push("plan.json: 'configs' must list at least one configuration.");
  const configNames = configs.map((c) => c.name);
  if (configNames.some((n) => typeof n !== "string" || !n)) errors.push("plan.json: every configuration needs a 'name'.");
  if (new Set(configNames).size !== configNames.length) errors.push("plan.json: configuration names must be unique.");
  if (!configNames.includes(plan.baseline_config)) errors.push(`plan.json: baseline_config '${plan.baseline_config}' is not one of the configurations (${configNames.join(", ")}).`);
  const planSeams = Array.isArray(plan.seams) ? plan.seams : [];
  if (!planSeams.length) errors.push("plan.json: 'seams' must list at least one seam id.");
  for (const id of planSeams) if (!seams.has(id)) errors.push(`plan.json: seam '${id}' is not in seams.json (known: ${[...seams.keys()].join(", ")}).`);
  const trials = merge(standard.trials, plan.trials ?? {});

  const byKey = new Map();
  for (const r of records) {
    const where = `records.jsonl line ${r._line}`;
    const seam = seams.get(r.seam);
    if (!planSeams.includes(r.seam)) errors.push(`${where}: seam '${r.seam}' is not in the plan.`);
    if (!configNames.includes(r.config)) errors.push(`${where}: config '${r.config}' is not in the plan.`);
    if (!isPositiveInt(r.trial)) errors.push(`${where}: 'trial' must be a positive integer.`);
    if (!statuses.includes(r.status)) errors.push(`${where}: 'status' must be one of ${statuses.join(", ")}.`);
    if (typeof r.duration_s !== "number" || r.duration_s < 0) errors.push(`${where}: 'duration_s' must be a number of seconds >= 0.`);
    if (r.cost_usd !== undefined && r.cost_usd !== null && (typeof r.cost_usd !== "number" || r.cost_usd < 0)) errors.push(`${where}: 'cost_usd' must be a number >= 0 or omitted.`);
    if (r.usage !== undefined) {
      if (!Array.isArray(r.usage)) errors.push(`${where}: 'usage' must be an array of { model, input, output, cache_read, cache_write }.`);
      else for (const u of r.usage) {
        if (typeof u.model !== "string" || !u.model) errors.push(`${where}: every usage entry needs a 'model'.`);
        for (const f of tokenFields) if (u[f] !== undefined && !(Number.isFinite(u[f]) && u[f] >= 0)) errors.push(`${where}: usage.${f} must be a number >= 0.`);
      }
    }
    if (r.quality !== undefined && !isObject(r.quality)) errors.push(`${where}: 'quality' must be an object of measure name to score.`);
    const key = `${r.seam}|${r.config}|${r.trial}`;
    if (byKey.has(key)) errors.push(`${where}: duplicate trial ${r.trial} for ${r.seam} / ${r.config} (also line ${byKey.get(key)._line}).`);
    byKey.set(key, { ...r, quality: { ...(r.quality ?? {}) } });
    if (seam) checkQuality(where, r.quality ?? {}, seam, errors);
  }

  for (const g of grades) {
    const where = `grades.jsonl line ${g._line}`;
    const rec = byKey.get(`${g.seam}|${g.config}|${g.trial}`);
    if (!rec) {
      errors.push(`${where}: no record for ${g.seam} / ${g.config} / trial ${g.trial}.`);
      continue;
    }
    if (!isObject(g.quality)) {
      errors.push(`${where}: 'quality' must be an object of measure name to score.`);
      continue;
    }
    const seam = seams.get(g.seam);
    if (seam) checkQuality(where, g.quality, seam, errors);
    Object.assign(rec.quality, g.quality);
  }

  const merged = [...byKey.values()];
  for (const r of merged) {
    const seam = seams.get(r.seam);
    if (!seam || r.status !== "ok") continue;
    const missing = (seam.quality ?? []).map((m) => m.name).filter((n) => r.quality[n] === undefined);
    if (missing.length) errors.push(`${r.seam} / ${r.config} / trial ${r.trial}: succeeded but has no score for ${missing.join(", ")}. Add it to records.jsonl or grades.jsonl.`);
  }

  for (const id of planSeams) {
    const seam = seams.get(id);
    if (!seam || planOnly) continue;
    const measuredIn = seam.isolation === "attributed" ? seams.get(seam.attributed_from) ?? seam : seam;
    const need = measuredIn.kind === "end_to_end" ? trials.end_to_end : trials.seam;
    for (const c of configNames) {
      const have = merged.filter((r) => r.seam === id && r.config === c).length;
      if (have < need) errors.push(`${id} / ${c}: ${have} of ${need} trials recorded.`);
    }
  }

  if (narrative) {
    const sections = standard.report.sections;
    if (sections.includes("summary") && !(typeof narrative.summary === "string" && narrative.summary.trim())) errors.push("narrative.json: 'summary' is required.");
    for (const k of ["observations", "recommendations"])
      if (narrative[k] !== undefined && !(Array.isArray(narrative[k]) && narrative[k].every((s) => typeof s === "string"))) errors.push(`narrative.json: '${k}' must be an array of strings.`);
    for (const id of Object.keys(narrative.seam_notes ?? {})) if (!planSeams.includes(id)) errors.push(`narrative.json: seam_notes has '${id}', which is not in the plan.`);
    for (const s of sections.filter((s) => !builtInSections.includes(s)))
      if (!(typeof narrative.custom?.[s] === "string" && narrative.custom[s].trim())) errors.push(`narrative.json: the standard lists a custom section '${s}', so custom.${s} needs its Markdown text.`);
  }

  return { errors, warnings, standard, standardFile, seams, plan, configs, planSeams, trials, records: merged, narrative };
}

function checkQuality(where, quality, seam, errors) {
  const known = new Set((seam.quality ?? []).map((m) => m.name));
  for (const [name, v] of Object.entries(quality)) {
    if (!known.has(name)) errors.push(`${where}: quality '${name}' is not a measure of seam '${seam.id}' (measures: ${[...known].join(", ")}).`);
    if (v !== null && !(typeof v === "number" && v >= 0 && v <= 1)) errors.push(`${where}: quality '${name}' must be a score from 0 to 1, or null when it doesn't apply to this trial; got ${JSON.stringify(v)}.`);
  }
}

function stats(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { n: xs.length, mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}

function trialCost(r, pricing, unpriced) {
  if (typeof r.cost_usd === "number") return r.cost_usd;
  if (!Array.isArray(r.usage) || !r.usage.length) return null;
  let total = 0;
  for (const u of r.usage) {
    const p = pricing[u.model];
    if (!p) {
      unpriced.add(u.model);
      return null;
    }
    total += ((u.input ?? 0) * p.input + (u.output ?? 0) * p.output + (u.cache_read ?? 0) * (p.cache_read ?? p.input) + (u.cache_write ?? 0) * (p.cache_write ?? p.input)) / 1e6;
  }
  return total;
}

function trialTokens(r) {
  if (!Array.isArray(r.usage) || !r.usage.length) return null;
  return r.usage.reduce((sum, u) => sum + tokenFields.reduce((s, f) => s + (u[f] ?? 0), 0), 0);
}

// Failed trials still spent money and time, so they count toward cost and time; their unscored measures count as 0.
// A null score means the measure doesn't apply to this trial, so it is left out of the weighted mean.
function measureScore(r, name) {
  const v = r.quality[name];
  return v === null ? null : v ?? 0;
}

function trialQuality(r, seam) {
  let sum = 0;
  let weights = 0;
  for (const m of seam.quality) {
    const v = measureScore(r, m.name);
    if (v === null) continue;
    const w = m.weight ?? 1;
    sum += w * v;
    weights += w;
  }
  return weights ? sum / weights : null;
}

function aggregate(data) {
  const unpriced = new Set();
  const groups = [];
  for (const id of data.planSeams) {
    const seam = data.seams.get(id);
    for (const c of data.configs) {
      const rs = data.records.filter((r) => r.seam === id && r.config === c.name).sort((a, b) => a.trial - b.trial);
      const costs = rs.map((r) => trialCost(r, data.standard.pricing_usd_per_million_tokens, unpriced));
      const byMeasure = {};
      for (const m of seam.quality) byMeasure[m.name] = stats(rs.map((r) => measureScore(r, m.name)));
      groups.push({
        seam: id, kind: seam.kind, config: c.name, trials: rs.length,
        ok: rs.filter((r) => r.status === "ok").length,
        success_rate: rs.length ? rs.filter((r) => r.status === "ok").length / rs.length : 0,
        cost_unmeasured: costs.filter((v) => v === null).length,
        cost: stats(costs), time: stats(rs.map((r) => r.duration_s)),
        quality: stats(rs.map((r) => trialQuality(r, seam))), tokens: stats(rs.map(trialTokens)),
        by_measure: byMeasure,
      });
    }
  }
  return { groups, unpriced: [...unpriced] };
}

function withinNoise(a, b) {
  return !!(a && b && a.n > 1 && b.n > 1 && Math.abs(a.mean - b.mean) <= Math.max(a.sd, b.sd));
}

function compare(candidate, reference, against, thresholds) {
  const pct = (c, r) => (c && r && r.mean > 0 ? ((c.mean - r.mean) / r.mean) * 100 : null);
  const pts = (c, r) => (c && r ? (c.mean - r.mean) * 100 : null);
  // An average over only the priced trials is biased (a failed trial is often the cheap one), so unpriced trials make cost incomparable.
  const costComparable = !candidate.cost_unmeasured && !reference.cost_unmeasured;
  const out = {
    seam: candidate.seam, config: candidate.config, against,
    cost_pct: costComparable ? pct(candidate.cost, reference.cost) : null, time_pct: pct(candidate.time, reference.time),
    quality_points: pts(candidate.quality, reference.quality),
    success_points: (candidate.success_rate - reference.success_rate) * 100,
    noise: {
      cost: withinNoise(candidate.cost, reference.cost),
      time: withinNoise(candidate.time, reference.time),
      quality: withinNoise(candidate.quality, reference.quality),
    },
    flags: [],
  };
  if (out.cost_pct !== null && out.cost_pct > thresholds.cost_pct && !out.noise.cost) out.flags.push(`cost ${signed(out.cost_pct, 0)}% (threshold ${thresholds.cost_pct}%)`);
  if (out.time_pct !== null && out.time_pct > thresholds.time_pct && !out.noise.time) out.flags.push(`time ${signed(out.time_pct, 0)}% (threshold ${thresholds.time_pct}%)`);
  if (out.quality_points !== null && -out.quality_points > thresholds.quality_points && !out.noise.quality) out.flags.push(`quality ${signed(out.quality_points, 0)} pts (threshold ${thresholds.quality_points} pts)`);
  if (-out.success_points > thresholds.success_rate_points) out.flags.push(`success rate ${signed(out.success_points, 0)} pts (threshold ${thresholds.success_rate_points} pts)`);
  return out;
}

function signed(v, digits) {
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : v < 0 ? s.replace("-", "\u2212") : s;
}

function money(v) {
  return `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
}

function duration(sec) {
  if (sec < 90) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${String(Math.round(sec - m * 60)).padStart(2, "0")}s`;
}

function count(v) {
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`;
}

function spread(s, fmt) {
  if (!s) return "not measured";
  return s.n > 1 ? `${fmt(s.mean)} \u00b1 ${fmt(s.sd)}` : fmt(s.mean);
}

function pctText(v) {
  return `${Math.round(v * 100)}%`;
}

function deltaText(cmp) {
  if (!cmp) return "baseline";
  const parts = [];
  const tag = (noise) => (noise ? " (noise)" : "");
  if (cmp.cost_pct !== null) parts.push(`cost ${signed(cmp.cost_pct, 0)}%${tag(cmp.noise.cost)}`);
  else parts.push("cost not comparable");
  if (cmp.time_pct !== null) parts.push(`time ${signed(cmp.time_pct, 0)}%${tag(cmp.noise.time)}`);
  if (cmp.quality_points !== null) parts.push(`quality ${signed(cmp.quality_points, 0)} pts${tag(cmp.noise.quality)}`);
  return parts.join(", ") || "\u2014";
}

function cell(v) {
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function render(data, result, previous) {
  const { standard, plan, narrative, seams } = data;
  const L = [];
  const sectionTitle = (s) => s.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  const baselineCmp = (g) => result.comparisons.find((c) => c.seam === g.seam && c.config === g.config && c.against === `baseline:${plan.baseline_config}`);

  const seamTable = (id) => {
    const seam = seams.get(id);
    L.push(`### ${id}`, "");
    if (seam.description) L.push(seam.description, "");
    if (seam.isolation === "attributed") L.push(`Not run in isolation: measured from this seam's share of the \`${seam.attributed_from}\` trials, so its numbers include whatever input those runs gave it.`, "");
    if (seam.boundary?.input || seam.boundary?.output) L.push(`Input: ${seam.boundary.input ?? "\u2014"}. Output: ${seam.boundary.output ?? "\u2014"}.`, "");
    L.push("| Config | Trials | Success | Cost per trial | Time per trial | Quality | Tokens | vs baseline |", "|---|---|---|---|---|---|---|---|");
    for (const g of result.groups.filter((g) => g.seam === id)) {
      const cost = g.cost ? spread(g.cost, money) + (g.cost_unmeasured ? ` (${g.cost_unmeasured} unmeasured)` : "") : "not measured";
      L.push(`| ${cell(g.config)}${g.config === plan.baseline_config ? " (baseline)" : ""} | ${g.trials} | ${pctText(g.success_rate)} | ${cost} | ${spread(g.time, duration)} | ${spread(g.quality, pctText)} | ${spread(g.tokens, count)} | ${deltaText(baselineCmp(g))} |`);
    }
    L.push("");
    if (seam.quality.length > 1) {
      L.push(`| Config | ${seam.quality.map((m) => cell(m.name)).join(" | ")} |`, `|---|${seam.quality.map(() => "---").join("|")}|`);
      for (const g of result.groups.filter((g) => g.seam === id)) L.push(`| ${cell(g.config)} | ${seam.quality.map((m) => spread(g.by_measure[m.name], pctText)).join(" | ")} |`);
      L.push("");
    }
    if (narrative.seam_notes?.[id]) L.push(narrative.seam_notes[id], "");
  };

  const bullets = (items, empty) => {
    if (items?.length) for (const i of items) L.push(`- ${i}`);
    else L.push(empty);
    L.push("");
  };

  const sections = {
    summary: () => L.push(narrative.summary.trim(), ""),
    configurations: () => {
      L.push("| Config | Description | Settings |", "|---|---|---|");
      for (const c of data.configs) L.push(`| ${cell(c.name)}${c.name === plan.baseline_config ? " (baseline)" : ""} | ${cell(c.description ?? "")} | ${c.settings ? `\`${cell(JSON.stringify(c.settings))}\`` : ""} |`);
      L.push("");
    },
    end_to_end: () => {
      const ids = data.planSeams.filter((id) => seams.get(id).kind === "end_to_end");
      if (!ids.length) L.push("No end-to-end workflow was run in this benchmark.", "");
      for (const id of ids) seamTable(id);
    },
    seams: () => {
      const ids = data.planSeams.filter((id) => seams.get(id).kind !== "end_to_end");
      if (!ids.length) L.push("No seams were benchmarked separately in this run.", "");
      for (const id of ids) seamTable(id);
    },
    comparison: () => {
      const flagged = result.comparisons.filter((c) => c.flags.length);
      L.push(`Worse than the reference beyond the thresholds in the standard. A difference within one standard deviation of run-to-run variation is marked "(noise)" in the tables and never flagged.`, "");
      if (flagged.length) for (const c of flagged) L.push(`- **${c.seam} / ${c.config}** vs ${c.against.replace(":", " ")}: ${c.flags.join("; ")}`);
      else L.push("Nothing was worse than its reference beyond the thresholds.");
      L.push("");
      if (previous) {
        L.push(`#### Against the previous run (${previous.run_id})`, "");
        const prev = result.comparisons.filter((c) => c.against === `previous:${previous.run_id}`);
        if (!prev.length) L.push("No seam and configuration pairs in common with the previous run.", "");
        else {
          L.push("| Seam | Config | Change |", "|---|---|---|");
          for (const c of prev) L.push(`| ${cell(c.seam)} | ${cell(c.config)} | ${deltaText(c)}${c.flags.length ? ` **(${c.flags.join("; ")})**` : ""} |`);
          L.push("");
        }
      }
    },
    observations: () => bullets(narrative.observations, "None recorded."),
    recommendations: () => bullets(narrative.recommendations, "None recorded."),
    method: () => {
      L.push(`- Trials per configuration: ${data.trials.seam} for each seam, ${data.trials.end_to_end} for each end-to-end workflow.`);
      L.push(`- Time is wall-clock seconds per trial. Cost is per trial, from the system's recorded cost where present, otherwise tokens times the prices below. Failed trials count toward cost and time, and their unscored quality measures count as 0.`);
      L.push(`- Quality is the weighted mean of each seam's measures, each scored 0 to 1.`);
      if (plan.grader) L.push(`- Grader: ${plan.grader}.`);
      if (plan.system_commit) L.push(`- System commit: \`${plan.system_commit}\`.`);
      L.push(`- Standard: \`${path.relative(path.dirname(data.standardFile), data.standardFile)}\` in \`.benchmark/\`.`, "");
      L.push("| Seam | Measure | Kind | Weight | How it is scored |", "|---|---|---|---|---|");
      for (const id of data.planSeams) for (const m of seams.get(id).quality) L.push(`| ${cell(id)} | ${cell(m.name)} | ${cell(m.kind ?? "")} | ${m.weight ?? 1} | ${cell(m.how ?? "")} |`);
      L.push("");
      const prices = Object.entries(standard.pricing_usd_per_million_tokens);
      if (prices.length) {
        L.push("| Model | Input | Output | Cache read | Cache write |", "|---|---|---|---|---|");
        for (const [m, p] of prices) L.push(`| ${cell(m)} | $${p.input} | $${p.output} | $${p.cache_read ?? p.input} | $${p.cache_write ?? p.input} |`);
        L.push("", "Prices are USD per million tokens.", "");
      }
      if (result.warnings.length) {
        L.push("Warnings:", "");
        for (const w of result.warnings) L.push(`- ${w}`);
        L.push("");
      }
    },
  };

  L.push(`# ${standard.report.title}: ${standard.system || plan.system || "system"}`, "");
  L.push(`Run \`${plan.run_id}\`${plan.label ? ` (${plan.label})` : ""}, generated ${result.generated_at.slice(0, 10)}. Baseline configuration: **${plan.baseline_config}**.`, "");
  for (const s of standard.report.sections) {
    L.push(`## ${sectionTitle(s)}`, "");
    if (sections[s]) sections[s]();
    else L.push(narrative.custom[s].trim(), "");
  }
  if (standard.report.per_trial_table) {
    L.push("## Appendix: every trial", "", "| Seam | Config | Trial | Status | Time | Cost | Quality | Notes |", "|---|---|---|---|---|---|---|---|");
    const unpriced = new Set();
    for (const r of [...data.records].sort((a, b) => a.seam.localeCompare(b.seam) || a.config.localeCompare(b.config) || a.trial - b.trial)) {
      const c = trialCost(r, standard.pricing_usd_per_million_tokens, unpriced);
      const q = trialQuality(r, seams.get(r.seam));
      L.push(`| ${cell(r.seam)} | ${cell(r.config)} | ${r.trial} | ${r.status} | ${duration(r.duration_s)} | ${c === null ? "\u2014" : money(c)} | ${q === null ? "n/a" : pctText(q)} | ${cell(r.notes ?? "")} |`);
    }
    L.push("");
  }
  return L.join("\n");
}

function printErrors(errors) {
  console.error(`Found ${errors.length} problem${errors.length === 1 ? "" : "s"}; nothing was written:`);
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

function validate(opts) {
  const planOnly = opts["plan-only"] === true;
  const data = load(runContext(opts.run), { withNarrative: false, planOnly });
  for (const w of data.warnings) console.log(`Warning: ${w}`);
  if (data.errors.length) printErrors(data.errors);
  if (planOnly) {
    const unpriced = new Set(data.configs.flatMap((c) => c.models ?? []).filter((m) => !data.standard.pricing_usd_per_million_tokens[m]));
    console.log(`Plan is valid: ${data.planSeams.length} seams x ${data.configs.length} configurations, ${data.trials.seam} trials per seam and ${data.trials.end_to_end} per end-to-end workflow.`);
    if (unpriced.size) console.log(`Warning: the plan's configurations use models with no price in the standard: ${[...unpriced].join(", ")}. Ask the user for prices or expect tokens only.`);
    return;
  }
  console.log(`Valid: ${data.records.length} trials across ${data.planSeams.length} seams and ${data.configs.length} configurations.`);
  const { groups, unpriced } = aggregate(data);
  printGroups(groups);
  if (unpriced.length) console.log(`Warning: no price in the standard for ${unpriced.join(", ")}.`);
}

function printGroups(groups) {
  for (const g of groups) {
    console.log(`${g.seam} / ${g.config}: ${g.ok}/${g.trials} ok, cost ${spread(g.cost, money)}${g.cost && g.cost_unmeasured ? ` (${g.cost_unmeasured} unmeasured)` : ""}, time ${spread(g.time, duration)}, quality ${spread(g.quality, pctText)}`);
  }
}

function report(opts) {
  const ctx = runContext(opts.run);
  const data = load(ctx, { withNarrative: true });
  if (data.errors.length) printErrors(data.errors);

  const { groups, unpriced } = aggregate(data);
  const warnings = [...data.warnings];
  if (unpriced.length) warnings.push(`No price in the standard for ${unpriced.join(", ")}, so trials that used them have no cost. Add them to pricing_usd_per_million_tokens and regenerate.`);
  const noCost = groups.filter((g) => !g.cost).map((g) => `${g.seam} / ${g.config}`);
  if (noCost.length) warnings.push(`Cost was not measured for ${noCost.join(", ")}.`);
  const thresholds = data.standard.thresholds;
  const comparisons = [];
  for (const g of groups) {
    if (g.config === data.plan.baseline_config) continue;
    const base = groups.find((b) => b.seam === g.seam && b.config === data.plan.baseline_config);
    comparisons.push(compare(g, base, `baseline:${data.plan.baseline_config}`, thresholds));
  }
  let previous = null;
  if (opts.previous) {
    const prevFile = path.join(path.resolve(opts.previous), "results.json");
    previous = readJson(prevFile, "Previous run results");
    for (const g of groups) {
      const p = previous.groups?.find((x) => x.seam === g.seam && x.config === g.config);
      if (p) comparisons.push(compare(g, p, `previous:${previous.run_id}`, thresholds));
    }
  }
  const result = {
    run_id: data.plan.run_id, system: data.standard.system, generated_at: new Date().toISOString(),
    baseline_config: data.plan.baseline_config, groups, comparisons, warnings,
  };
  fs.writeFileSync(path.join(ctx.runDir, "results.json"), JSON.stringify(result, null, 2) + "\n");
  const reportFile = path.join(ctx.runDir, "REPORT.md");
  fs.writeFileSync(reportFile, render(data, result, previous));

  printGroups(groups);
  const flagged = comparisons.filter((c) => c.flags.length);
  console.log(flagged.length ? `${flagged.length} flagged comparison${flagged.length === 1 ? "" : "s"}:` : "No flagged comparisons.");
  for (const c of flagged) console.log(`  ${c.seam} / ${c.config} vs ${c.against}: ${c.flags.join("; ")}`);
  for (const w of warnings) console.log(`Warning: ${w}`);
  console.log(`Wrote ${reportFile}`);
}

const [command, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
if (command === "init") init(opts._[0]);
else if (command === "validate") validate(opts);
else if (command === "report") report(opts);
else die("Usage:\n  node benchmark.mjs init <system-root>\n  node benchmark.mjs validate --run <run-dir>\n  node benchmark.mjs report --run <run-dir> [--previous <run-dir>]");
