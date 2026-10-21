#:property PublishAot=false
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;

const string Usage = """
    Usage: dotnet run quality.cs -- <command> [options]

    Register (only this script writes <repo>/.tech-debt/):
      reconcile  --repo <path> --commit <analyzed sha> --metrics <json> --review <json> --run <id>
                 [--matches <json>] [--prefix solid]
      claim      --repo <path> --id <item> --branch <name>
      mark-fixed --repo <path> --id <item> --commit <sha> --branch <name>
      accept     --repo <path> --id <item> --reason <text>        (only on a person's explicit words)
      render     --repo <path>

    Gates (exit 0 pass, 1 fail, 2 usage error; commands time out after --timeout-minutes, default 20):
      blind      --repo <path> --base <ref> --path <worktree> --hide <dir>[,<dir>]
      scope      --repo <path> --base <ref> --allow <file or dir/>[,...]
      repeat     --runs <n> -- <command...>
      sabotage   --project <test csproj> --test <fully qualified name> --file <production file> --find <text> --replace <text>
    """;

var jsonOut = new JsonSerializerOptions { WriteIndented = true };
string[] active = ["open", "in-progress", "fixed-pending-verification", "reopened"];
string[] severities = ["low", "medium", "high", "critical"];
var idPattern = new Regex("^[a-z]+-[0-9a-f]{6,8}$");
var timeout = TimeSpan.FromMinutes(20);

try
{
    if (args.Length == 0 || args[0] is "-h" or "--help") { Console.WriteLine(Usage); return 0; }
    var (opts, command) = Parse(args[1..]);
    if (opts.TryGetValue("timeout-minutes", out var t)) timeout = TimeSpan.FromMinutes(PositiveInt(t, "timeout-minutes"));
    return args[0] switch
    {
        "reconcile" => Reconcile(opts),
        "claim" or "mark-fixed" or "accept" => Transition(args[0], opts),
        "render" => Render(opts),
        "blind" => Blind(opts),
        "scope" => Scope(opts),
        "repeat" => Repeat(opts, command),
        "sabotage" => Sabotage(opts),
        _ => throw new UsageError($"Unknown command '{args[0]}'."),
    };
}
catch (UsageError e)
{
    Console.Error.WriteLine($"{e.Message}\n\n{Usage}");
    return 2;
}

int Reconcile(Dictionary<string, string> o)
{
    var repo = Req(o, "repo");
    var runId = Req(o, "run");
    var commit = Req(o, "commit");
    var prefix = o.GetValueOrDefault("prefix", "solid");
    var metrics = ReadJson(Req(o, "metrics"));
    var review = ReadJson(Req(o, "review"));
    var matchesDoc = o.TryGetValue("matches", out var mp) ? ReadJson(mp) : new JsonObject();
    var items = LoadItems(repo);

    var errors = new List<string>();
    var metricIds = Arr(metrics["findings"]).Select(f => Str(f, "id") ?? "").ToHashSet();
    var reviewed = new Dictionary<string, JsonObject>();
    foreach (var r in Arr(review["reviewed"]))
    {
        var id = Str(r, "id") ?? "";
        if (!metricIds.Contains(id)) errors.Add($"reviewed: '{id}' is not a finding id in the metrics file.");
        else if (!reviewed.TryAdd(id, r.AsObject())) errors.Add($"reviewed: '{id}' appears twice.");
        if (Str(r, "action") is not ("keep" or "dismiss" or "adjust")) errors.Add($"reviewed: '{id}' has action '{Str(r, "action")}'.");
        if (Str(r, "action") == "adjust" && !severities.Contains(Str(r, "severity"))) errors.Add($"reviewed: '{id}' adjusts without a valid severity.");
        if (Str(r, "action") == "dismiss" && string.IsNullOrWhiteSpace(Str(r, "reason"))) errors.Add($"reviewed: '{id}' is dismissed without a reason.");
    }
    var added = new List<(string Id, JsonObject Finding)>();
    foreach (var a in Arr(review["added"]))
    {
        var missing = new[] { "principle", "severity", "title", "type", "file", "details" }.Where(k => string.IsNullOrWhiteSpace(Str(a, k))).ToList();
        if (missing.Count > 0) { errors.Add($"added: '{Str(a, "title")}' is missing {string.Join(", ", missing)}."); continue; }
        if (!severities.Contains(Str(a, "severity"))) errors.Add($"added: '{Str(a, "title")}' has severity '{Str(a, "severity")}'.");
        var id = Str(a, "id") ?? StableId(prefix, Str(a, "principle")!, Str(a, "type")!, Str(a, "title")!);
        if (!idPattern.IsMatch(id)) errors.Add($"added: id '{id}' does not match {idPattern}.");
        if (metricIds.Contains(id) || added.Any(x => x.Id == id)) errors.Add($"added: id '{id}' is already used; give the finding a different title.");
        added.Add((id, a.AsObject()));
    }
    var matches = new Dictionary<string, string>();
    foreach (var m in Arr(matchesDoc["matches"]))
    {
        var fid = Str(m, "finding_id") ?? "";
        var target = Str(m, "match") ?? "";
        if (added.All(x => x.Id != fid)) errors.Add($"matches: '{fid}' is not an added finding.");
        else if (target == "new") continue;
        else if (!items.TryGetValue(target, out var hit) || Str(hit, "source") != "review") errors.Add($"matches: '{target}' is not a review-added register item.");
        else matches[fid] = target;
    }
    var checks = new Dictionary<string, JsonObject>();
    foreach (var c in Arr(review["register_checks"]))
    {
        var id = Str(c, "id") ?? "";
        if (!items.ContainsKey(id)) errors.Add($"register_checks: '{id}' is not in the register.");
        else if (!checks.TryAdd(id, c.AsObject())) errors.Add($"register_checks: '{id}' appears twice.");
        if (Str(c, "status") is not ("present" or "fixed")) errors.Add($"register_checks: '{id}' has status '{Str(c, "status")}'.");
        if (Arr(c["evidence"]).Count() == 0) errors.Add($"register_checks: '{id}' has no evidence.");
    }
    foreach (var item in items.Values.Where(i => Str(i, "source") == "review" && active.Contains(Str(i, "status"))))
        if (!checks.ContainsKey(Str(item, "id")!) && !matches.ContainsValue(Str(item, "id")!) && added.All(x => x.Id != Str(item, "id")))
            errors.Add($"register_checks: active review item '{Str(item, "id")}' needs a present or fixed check.");
    if (errors.Count > 0) return Verdict("reconcile", false, new JsonObject { ["problems"] = Json(errors) });

    var at = Now();
    var stamp = () => new JsonObject { ["run"] = runId, ["commit"] = commit };
    var changes = new List<string>();
    var seen = new HashSet<string>();

    void Record(JsonObject item, string change, string? from, string? note = null)
    {
        var to = Str(item, "status");
        if (change == "add" || from != to)
        {
            var h = new JsonObject { ["at"] = at, ["run"] = runId, ["change"] = change };
            if (from is not null && from != to) { h["from"] = from; h["to"] = to; }
            if (note is not null) h["note"] = note;
            item["history"]!.AsArray().Add((JsonNode)h);
        }
        changes.Add($"{change,-16} {Str(item, "id")}  {(from is null ? "" : from + " -> ")}{to}  {Str(item, "severity")}  {Str(item, "title")}{(note is null ? "" : $"  ({note})")}");
    }

    var observations = new List<(string Id, string Source, bool Dismissed, bool Carried, JsonObject Fields)>();
    foreach (var f in Arr(metrics["findings"]))
    {
        reviewed.TryGetValue(Str(f, "id")!, out var r);
        var fields = new JsonObject
        {
            ["severity"] = Str(r, "action") == "adjust" ? Str(r, "severity") : Str(f, "severity"),
            ["principle"] = Str(f, "principle"), ["criterion"] = Str(f, "criterion"), ["title"] = Str(f, "criterion"),
            ["type"] = Str(f, "type"), ["file"] = Str(f, "file"), ["line"] = f["line"]?.DeepClone(),
            ["details"] = Str(f, "details"), ["value"] = f["value"]?.DeepClone(), ["threshold"] = f["threshold"]?.DeepClone(),
        };
        foreach (var k in new[] { "recommendation", "reason", "evidence" })
            if (r?.ContainsKey(k) == true) fields[k] = r[k]?.DeepClone();
        observations.Add((Str(f, "id")!, "metric", Str(r, "action") == "dismiss", f["carried_forward"] is JsonValue cv && cv.TryGetValue<bool>(out var b) && b, fields));
    }
    foreach (var (id, a) in added)
    {
        var fields = new JsonObject
        {
            ["severity"] = Str(a, "severity"), ["principle"] = Str(a, "principle"), ["criterion"] = null, ["title"] = Str(a, "title"),
            ["type"] = Str(a, "type"), ["file"] = Str(a, "file"), ["line"] = a["line"]?.DeepClone() ?? 0, ["details"] = Str(a, "details"),
        };
        foreach (var k in new[] { "recommendation", "evidence" })
            if (a.ContainsKey(k)) fields[k] = a[k]?.DeepClone();
        observations.Add((matches.GetValueOrDefault(id, id), "review", false, false, fields));
    }

    foreach (var ob in observations)
    {
        seen.Add(ob.Id);
        if (!items.TryGetValue(ob.Id, out var existing))
        {
            var item = new JsonObject
            {
                ["schema_version"] = 1, ["id"] = ob.Id, ["analysis"] = prefix, ["source"] = ob.Source,
                ["status"] = ob.Dismissed ? "dismissed" : "open",
            };
            foreach (var (k, v) in ob.Fields) item[k] = v?.DeepClone();
            item["first_seen"] = stamp();
            item["last_seen"] = stamp();
            item["history"] = new JsonArray();
            items[ob.Id] = item;
            Record(item, "add", null);
            continue;
        }
        var from = Str(existing, "status")!;
        if (ob.Carried)
        {
            foreach (var k in new[] { "line", "file", "value", "details" }) existing[k] = ob.Fields[k]?.DeepClone();
            existing["last_seen"] = stamp();
            Record(existing, "carry", from);
            continue;
        }
        foreach (var (k, v) in ob.Fields) existing[k] = v?.DeepClone();
        existing["last_seen"] = stamp();
        var change = "update";
        string? note = null;
        var fixBranch = Str(existing["fix"], "branch");
        var fixCommit = Str(existing["fix"], "commit");
        if (ob.Dismissed) existing["status"] = "dismissed";
        else if (from == "resolved") { existing["status"] = "reopened"; change = "reopen"; }
        else if (from is "accepted" or "dismissed") { existing["status"] = "open"; note = "Severity rose above the level it was settled at; review kept it."; }
        else if (from == "fixed-pending-verification" && (fixBranch is not null || (fixCommit is not null && Git(repo, "merge-base", "--is-ancestor", fixCommit, commit).Code == 0)))
        {
            existing["status"] = "open";
            note = fixBranch is not null ? $"Still present after the fix from {fixBranch} was merged." : $"Still present in code that includes fix commit {Short(fixCommit)}.";
        }
        Record(existing, change, from, note);
    }

    foreach (var (id, check) in checks)
    {
        var item = items[id];
        if (!seen.Add(id)) continue;
        var from = Str(item, "status")!;
        item["evidence"] = check["evidence"]?.DeepClone();
        item["last_seen"] = stamp();
        if (Str(check, "status") == "fixed" && active.Contains(from))
        {
            item["status"] = "resolved";
            Record(item, "propose-resolved", from, "Analyst verified the problem is gone.");
        }
        else Record(item, "update", from);
    }

    foreach (var item in items.Values)
    {
        var from = Str(item, "status")!;
        if (seen.Contains(Str(item, "id")!) || Str(item, "source") != "metric") continue;
        if (!active.Contains(from) && from != "accepted") continue;
        item["status"] = "resolved";
        seen.Add(Str(item, "id")!);
        Record(item, "propose-resolved", from, "No longer reported by the analyzer.");
    }

    foreach (var id in seen) SaveItem(repo, items[id]);
    var runDir = Path.Combine(repo, ".tech-debt", "runs", prefix, runId);
    Directory.CreateDirectory(runDir);
    File.Copy(Req(o, "metrics"), Path.Combine(runDir, "metrics.json"), true);
    File.Copy(Req(o, "review"), Path.Combine(runDir, "review.json"), true);
    if (mp is not null) File.Copy(mp, Path.Combine(runDir, "matches.json"), true);
    File.WriteAllText(Path.Combine(runDir, "manifest.json"), new JsonObject
    {
        ["schema_version"] = 1, ["run_id"] = runId, ["analysis"] = prefix, ["commit"] = commit, ["at"] = at, ["changes"] = Json(changes),
    }.ToJsonString(jsonOut) + "\n");
    WriteTechDebt(repo, items.Values);
    foreach (var c in changes) Console.WriteLine(c);
    Console.WriteLine($"{changes.Count} changes, {items.Count} items in {Path.Combine(repo, ".tech-debt")}");
    return 0;
}

int Transition(string change, Dictionary<string, string> o)
{
    var repo = Req(o, "repo");
    var id = Req(o, "id");
    var items = LoadItems(repo);
    if (!items.TryGetValue(id, out var item)) throw new UsageError($"No register item '{id}'.");
    var from = Str(item, "status")!;
    var at = Now();
    var (allowed, to, note) = change switch
    {
        "claim" => (new[] { "open", "reopened" }, "in-progress", $"Claimed by quality-pstack on {Req(o, "branch")}"),
        "mark-fixed" => (new[] { "in-progress" }, "fixed-pending-verification", $"Fix in {Req(o, "commit")} on {Req(o, "branch")}"),
        _ => (new[] { "open", "reopened" }, "accepted", Req(o, "reason")),
    };
    if (!allowed.Contains(from)) throw new UsageError($"{id} is '{from}'; {change} needs one of: {string.Join(", ", allowed)}.");
    item["history"]!.AsArray().Add((JsonNode)new JsonObject { ["at"] = at, ["change"] = change, ["from"] = from, ["to"] = to, ["note"] = note });
    item["status"] = to;
    if (change == "claim") item["claim"] = new JsonObject { ["agent"] = "quality-pstack", ["branch"] = o["branch"], ["at"] = at };
    if (change == "mark-fixed") item["fix"] = new JsonObject { ["commit"] = o["commit"], ["at"] = at, ["branch"] = o["branch"] };
    if (change == "accept") item["reason"] = note;
    SaveItem(repo, item);
    WriteTechDebt(repo, items.Values);
    Console.WriteLine($"{id}: {from} -> {to}");
    return 0;
}

int Render(Dictionary<string, string> o)
{
    var repo = Req(o, "repo");
    WriteTechDebt(repo, LoadItems(repo).Values);
    Console.WriteLine(Path.Combine(repo, ".tech-debt", "TECH-DEBT.md"));
    return 0;
}

int Blind(Dictionary<string, string> o)
{
    var repo = Req(o, "repo");
    var path = Path.GetFullPath(Req(o, "path"));
    var hide = List(Req(o, "hide"));
    var add = Git(repo, "worktree", "add", "--detach", path, Req(o, "base"));
    if (add.Code != 0) return Fail("blind", add.Output);
    var sparse = Git(path, ["sparse-checkout", "set", "--no-cone", "/*", .. hide.Select(d => $"!/{d.Trim('/')}/")]);
    if (sparse.Code != 0) return Fail("blind", sparse.Output);
    var visible = hide.Where(d => Directory.Exists(Path.Combine(path, d))).ToList();
    return Verdict("blind", visible.Count == 0, new JsonObject { ["path"] = path, ["hidden"] = Json(hide), ["still_visible"] = Json(visible) });
}

int Scope(Dictionary<string, string> o)
{
    var repo = Req(o, "repo");
    var allow = List(Req(o, "allow")).Select(Norm).ToList();
    var tracked = Git(repo, "diff", "--name-only", "--no-renames", Req(o, "base"));
    if (tracked.Code != 0) return Fail("scope", tracked.Output);
    var untracked = Git(repo, "ls-files", "--others", "--exclude-standard");
    var changed = (tracked.Output + "\n" + untracked.Output).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(Norm).Distinct().ToList();
    var outside = changed.Where(f => !allow.Any(a => a.EndsWith('/') ? f.StartsWith(a, StringComparison.OrdinalIgnoreCase) : f.Equals(a, StringComparison.OrdinalIgnoreCase))).ToList();
    return Verdict("scope", outside.Count == 0, new JsonObject { ["changed"] = Json(changed), ["outside_allowed"] = Json(outside) });
}

int Repeat(Dictionary<string, string> o, string[] command)
{
    var runs = PositiveInt(Req(o, "runs"), "runs");
    var results = Enumerable.Range(0, runs).Select(_ => Run(command)).ToList();
    var failed = results.FindIndex(r => r.Code != 0);
    var details = new JsonObject { ["runs"] = runs, ["exit_codes"] = Json(results.Select(r => r.Code.ToString())) };
    if (failed >= 0) details["first_failure_tail"] = Tail(results[failed].Output);
    return Verdict("repeat", failed < 0, details);
}

int Sabotage(Dictionary<string, string> o)
{
    var project = Path.GetFullPath(Req(o, "project"));
    var test = Req(o, "test");
    var file = Path.GetFullPath(Req(o, "file"));
    var find = Req(o, "find");
    if (file.StartsWith(Path.GetDirectoryName(project)! + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        throw new UsageError("--file is inside the test project. A sabotage targets production code.");
    var original = File.ReadAllBytes(file);
    var hasBom = original.Length >= 3 && original[0] == 0xEF && original[1] == 0xBB && original[2] == 0xBF;
    var text = new UTF8Encoding(false).GetString(original, hasBom ? 3 : 0, original.Length - (hasBom ? 3 : 0));
    var count = CountOrdinal(text, find);
    if (count != 1) throw new UsageError($"--find must occur exactly once in {file}; it occurs {count} times.");
    var results = Path.Combine(Path.GetTempPath(), $"quality-sabotage-{Guid.NewGuid():N}");
    (int Code, string Output) build, run = (0, "");
    try
    {
        File.WriteAllText(file, text.Replace(find, Req(o, "replace"), StringComparison.Ordinal), new UTF8Encoding(hasBom));
        build = Run(["dotnet", "build", project]);
        if (build.Code == 0)
            run = Run(["dotnet", "test", project, "--no-build", "--filter", $"FullyQualifiedName~{test}", "--logger", "trx;LogFileName=sabotage.trx", "--results-directory", results]);
    }
    finally
    {
        File.WriteAllBytes(file, original);
        Run(["dotnet", "build", project]);
    }
    if (!File.ReadAllBytes(file).AsSpan().SequenceEqual(original)) return Fail("sabotage", $"{file} was not restored byte for byte.");
    if (build.Code != 0) return Verdict("sabotage", false, new JsonObject { ["test"] = test, ["reason"] = "The sabotaged code does not compile. Use a sabotage that compiles and changes behavior.", ["output_tail"] = Tail(build.Output) });

    var trx = Directory.Exists(results) ? Directory.GetFiles(results, "*.trx", SearchOption.AllDirectories).FirstOrDefault() : null;
    XNamespace ns = "http://microsoft.com/schemas/VisualStudio/TeamTest/2010";
    var outcomes = trx is null ? [] : XDocument.Load(trx).Descendants(ns + "UnitTestResult")
        .Where(r => (string?)r.Attribute("testName") is { } n && (n == test || n.StartsWith(test + "(")))
        .Select(r => (Outcome: (string?)r.Attribute("outcome"), Message: r.Descendants(ns + "Message").FirstOrDefault()?.Value.Trim() ?? ""))
        .ToList();
    if (Directory.Exists(results)) Directory.Delete(results, true);
    var unrelated = new Regex(@"^System\.[\w.]*Exception\b");
    var assertionFailures = outcomes.Where(r => r.Outcome == "Failed" && !unrelated.IsMatch(r.Message)).ToList();
    var reason = outcomes.Count == 0 ? $"No test named {test} ran."
        : assertionFailures.Count > 0 ? "An assertion caught the sabotage."
        : outcomes.Any(r => r.Outcome == "Failed") ? "The test failed only with an unrelated exception, not an assertion."
        : "The test still passes under its own sabotage.";
    return Verdict("sabotage", assertionFailures.Count > 0, new JsonObject
    {
        ["test"] = test, ["file"] = file, ["reason"] = reason,
        ["messages"] = Json(outcomes.Select(r => $"{r.Outcome}: {r.Message.Split('\n')[0]}")),
        ["output_tail"] = assertionFailures.Count > 0 ? null : Tail(run.Output),
    });
}

void WriteTechDebt(string repo, IEnumerable<JsonObject> all)
{
    var items = all.ToList();
    string[] sevOrder = ["critical", "high", "medium", "low"];
    IEnumerable<JsonObject> By(params string[] statuses) => items
        .Where(i => statuses.Contains(Str(i, "status")))
        .OrderBy(i => Array.IndexOf(sevOrder, Str(i, "severity"))).ThenBy(i => Str(i, "principle")).ThenBy(i => Str(i, "id"));
    static string Md(string? s) => (s ?? "").Replace("|", "\\|").ReplaceLineEndings(" ");
    static string Cap(string? s) => string.IsNullOrEmpty(s) ? "" : char.ToUpperInvariant(s[0]) + s[1..];
    string ShortType(JsonObject i) => Md(Str(i, "type")?.Split('<')[0].Split('.')[^1]);
    var open = By("open", "reopened").ToList();
    var lastRun = Directory.Exists(Path.Combine(repo, ".tech-debt", "runs"))
        ? Directory.GetFiles(Path.Combine(repo, ".tech-debt", "runs"), "manifest.json", SearchOption.AllDirectories).Select(ReadJson).MaxBy(m => Str(m, "at"))
        : null;
    var sb = new StringBuilder();
    void L(string s = "") => sb.Append(s).Append('\n');

    L("# Technical debt register");
    L();
    L("Generated from `items/`, one JSON file per item. Do not edit this file or the items by hand. Change them through `quality-pstack/scripts/quality.cs` or the refactor harness CLI.");
    L();
    if (lastRun is not null) L($"Last analysis: run `{Str(lastRun, "run_id")}` at commit `{Short(Str(lastRun, "commit"))}`.");
    L($"Open: {open.Count} ({string.Join(", ", sevOrder.Select(s => $"{open.Count(i => Str(i, "severity") == s)} {s}"))}). In progress: {By("in-progress").Count()}. Fixed, pending verification: {By("fixed-pending-verification").Count()}. Accepted: {By("accepted").Count()}. Dismissed: {By("dismissed").Count()}. Resolved: {By("resolved").Count()}.");
    L();
    L("## Open");
    L();
    if (open.Count == 0) L("Nothing open.");
    else
    {
        L("| Id | Severity | Principle | Type | Issue | Location |");
        L("|---|---|---|---|---|---|");
        foreach (var i in open)
            L($"| `{Str(i, "id")}` | {Cap(Str(i, "severity"))}{(Str(i, "status") == "reopened" ? " (reopened)" : "")} | {Str(i, "principle")?.ToUpperInvariant()} | `{ShortType(i)}` | {Md(Str(i, "criterion") is { } c ? $"{c}: {Str(i, "details")}" : Str(i, "title"))} | `{Str(i, "file")}:{i["line"]}` |");
    }
    foreach (var (status, heading, col, value) in new (string, string, string, Func<JsonObject, string>)[]
    {
        ("in-progress", "In progress", "Branch", i => $"`{Md(Str(i["claim"], "branch"))}`"),
        ("fixed-pending-verification", "Fixed, pending verification", "Fix commit", i => $"`{Short(Str(i["fix"], "commit"))}`"),
        ("accepted", "Accepted", "Reason", i => Md(Str(i, "reason"))),
    })
    {
        var list = By(status).ToList();
        if (list.Count == 0) continue;
        L();
        L($"## {heading}");
        L();
        L($"| Id | Severity | Type | {col} |");
        L("|---|---|---|---|");
        foreach (var i in list) L($"| `{Str(i, "id")}` | {Cap(Str(i, "severity"))} | `{ShortType(i)}` | {value(i)} |");
    }
    File.WriteAllText(Path.Combine(repo, ".tech-debt", "TECH-DEBT.md"), sb.ToString());
}

Dictionary<string, JsonObject> LoadItems(string repo)
{
    var dir = Path.Combine(repo, ".tech-debt", "items");
    Directory.CreateDirectory(dir);
    return Directory.GetFiles(dir, "*.json").Select(f => ReadJson(f).AsObject()).ToDictionary(i => Str(i, "id")!);
}

void SaveItem(string repo, JsonObject item) =>
    File.WriteAllText(Path.Combine(repo, ".tech-debt", "items", $"{Str(item, "id")}.json"), item.ToJsonString(jsonOut) + "\n");

int Verdict(string gate, bool pass, JsonObject details)
{
    details["gate"] = gate;
    details["verdict"] = pass ? "PASS" : "FAIL";
    Console.WriteLine(details.ToJsonString(jsonOut));
    return pass ? 0 : 1;
}

int Fail(string gate, string message) => Verdict(gate, false, new JsonObject { ["error"] = message.Trim() });

(int Code, string Output) Git(string dir, params string[] gitArgs) => Run(["git", "-C", dir, .. gitArgs]);

(int Code, string Output) Run(string[] command)
{
    if (command.Length == 0) throw new UsageError("Missing command after '--'.");
    var psi = new ProcessStartInfo(command[0]) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
    foreach (var a in command[1..]) psi.ArgumentList.Add(a);
    var output = new StringBuilder();
    using var p = new Process { StartInfo = psi };
    p.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (output) output.AppendLine(e.Data); };
    p.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (output) output.AppendLine(e.Data); };
    p.Start();
    p.BeginOutputReadLine();
    p.BeginErrorReadLine();
    if (p.WaitForExit(timeout)) { p.WaitForExit(); return (p.ExitCode, output.ToString()); }
    p.Kill(entireProcessTree: true);
    return (-1, output + $"\nTimed out after {timeout.TotalMinutes} minutes: {string.Join(' ', command)}");
}

static (Dictionary<string, string>, string[]) Parse(string[] rest)
{
    var split = Array.IndexOf(rest, "--");
    var options = split < 0 ? rest : rest[..split];
    var command = split < 0 ? [] : rest[(split + 1)..];
    var o = new Dictionary<string, string>();
    for (var i = 0; i < options.Length; i++)
    {
        if (!options[i].StartsWith("--") || i + 1 >= options.Length) throw new UsageError($"Expected '--name value', got '{options[i]}'.");
        o[options[i][2..]] = options[++i];
    }
    return (o, command);
}

static string Req(Dictionary<string, string> o, string key) =>
    o.TryGetValue(key, out var v) ? v : throw new UsageError($"Missing --{key}.");

static int PositiveInt(string value, string name) =>
    int.TryParse(value, out var n) && n > 0 ? n : throw new UsageError($"--{name} must be a positive whole number, got '{value}'.");

static string StableId(string prefix, string principle, string type, string title)
{
    var normalized = Regex.Replace(title.ToLowerInvariant(), "[^a-z0-9]+", " ").Trim();
    var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{principle}|{type}|{normalized}")));
    return $"{prefix}-{hash[..6]}";
}

static int CountOrdinal(string text, string find)
{
    var count = 0;
    for (var i = text.IndexOf(find, StringComparison.Ordinal); i >= 0; i = text.IndexOf(find, i + find.Length, StringComparison.Ordinal)) count++;
    return count;
}

static JsonNode ReadJson(string path)
{
    try { return JsonNode.Parse(File.ReadAllText(path)) ?? throw new UsageError($"{path} is empty."); }
    catch (Exception e) when (e is JsonException or IOException) { throw new UsageError($"Cannot read {path}: {e.Message}"); }
}

static IEnumerable<JsonNode> Arr(JsonNode? node) => node is JsonArray a ? a.OfType<JsonNode>() : [];
static string? Str(JsonNode? node, string key) => node is JsonObject obj && obj[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
static JsonArray Json(IEnumerable<string> values) => new(values.Select(v => (JsonNode?)JsonValue.Create(v)).ToArray());
static List<string> List(string csv) => csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
static string Norm(string path) => path.Replace('\\', '/') is var p && p.StartsWith("./") ? p[2..] : p;
static string Short(string? sha) => sha is null ? "" : sha.Length > 7 ? sha[..7] : sha;
static string Tail(string output) => string.Join('\n', output.TrimEnd().Split('\n').TakeLast(40));
static string Now() => DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");

sealed class UsageError(string message) : Exception(message);
