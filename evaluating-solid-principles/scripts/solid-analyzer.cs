#:package Microsoft.CodeAnalysis.CSharp@4.14.0
#:package YamlDotNet@16.3.0
#:property PublishAot=false
#:property Nullable=enable

// SOLID analyzer for C# repositories.
//   analyze: parses every .cs file with Roslyn, computes per-type metrics, and classifies them
//            against the thresholds (bundled defaults merged with the repo's solid-thresholds.yaml).
//   report:  applies the reviewer's decisions (solid-review.json), rolls findings up into
//            per-principle and overall risk ratings, and renders the Markdown risk profile.

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using YamlDotNet.Serialization;

CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
return Cli.Run(args);

// ---------------------------------------------------------------- CLI

static class Cli
{
    const string Usage = """
        Usage:
          dotnet run solid-analyzer.cs -- analyze <repo-path> [--config <yaml>] [--defaults <yaml>] [--out <metrics.json>] [--register <tech-debt-dir>]
          dotnet run solid-analyzer.cs -- report --metrics <metrics.json> [--review <review.json>] [--out <report.md>]
        """;

    public static int Run(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help")
        {
            Console.WriteLine(Usage);
            return args.Length == 0 ? 1 : 0;
        }
        try
        {
            var (positional, options) = Parse(args.Skip(1).ToList());
            return args[0] switch
            {
                "analyze" => Analyzer.Run(positional, options),
                "report" => Reporter.Run(options),
                _ => throw new UserError($"Unknown command '{args[0]}'.\n{Usage}"),
            };
        }
        catch (UserError e)
        {
            Console.Error.WriteLine($"ERROR: {e.Message}");
            return 2;
        }
    }

    static (List<string>, Dictionary<string, string>) Parse(List<string> args)
    {
        var positional = new List<string>();
        var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Count; i++)
        {
            if (!args[i].StartsWith("--")) { positional.Add(args[i]); continue; }
            if (i + 1 >= args.Count) throw new UserError($"Option {args[i]} needs a value.");
            options[args[i][2..]] = args[++i];
        }
        return (positional, options);
    }
}

sealed class UserError(string message) : Exception(message);

// ---------------------------------------------------------------- Shared helpers

static class Sev
{
    public static readonly string[] Ascending = ["low", "medium", "high", "critical"];
    public static readonly string[] Descending = ["critical", "high", "medium", "low"];
    public static int Rank(string s) => Array.IndexOf(Ascending, s);
    public static bool Valid(string? s) => s is not null && Rank(s) >= 0;
    public static string Title(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];
}

static class Principle
{
    public static readonly string[] All = ["srp", "ocp", "lsp", "isp", "dip"];
    public static string Name(string p) => p switch
    {
        "srp" => "Single Responsibility",
        "ocp" => "Open/Closed",
        "lsp" => "Liskov Substitution",
        "isp" => "Interface Segregation",
        "dip" => "Dependency Inversion",
        _ => p,
    };
}

static class Json
{
    public static double? Num(JsonNode? n)
    {
        if (n is not JsonValue v) return null;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
        return null;
    }

    public static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : n?.ToJsonString();

    public static bool Bool(JsonNode? n, bool fallback)
    {
        if (n is JsonValue v && v.TryGetValue<bool>(out var b)) return b;
        var s = Str(n);
        return s is null ? fallback : s.Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    public static List<string> Strs(JsonNode? n) =>
        n is JsonArray a ? a.Select(Str).Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s!).ToList() : [];

    public static JsonObject Merge(JsonObject baseObj, JsonObject overrides)
    {
        var result = (JsonObject)baseObj.DeepClone();
        foreach (var (key, value) in overrides)
        {
            if (result[key] is JsonObject b && value is JsonObject o) result[key] = Merge(b, o);
            else result[key] = value?.DeepClone();
        }
        return result;
    }

    public static JsonObject LoadYaml(string path)
    {
        var yaml = new DeserializerBuilder().Build().Deserialize<object>(new StringReader(File.ReadAllText(path)));
        if (yaml is null) return [];
        var json = new SerializerBuilder().JsonCompatible().Build().Serialize(yaml);
        return JsonNode.Parse(json) as JsonObject ?? throw new UserError($"{path} must contain a YAML mapping at the top level.");
    }
}

static class Fmt
{
    public static string Num(double v) =>
        v == Math.Floor(v) ? ((long)v).ToString(CultureInfo.InvariantCulture) : v.ToString("0.##", CultureInfo.InvariantCulture);
}

// ---------------------------------------------------------------- Configuration

sealed record Criterion(string Principle, string Name, bool Enabled, double? Low, double? Medium, double? High, double? Critical, JsonObject Raw)
{
    public double? For(string level) => level switch
    {
        "low" => Low,
        "medium" => Medium,
        "high" => High,
        "critical" => Critical,
        _ => null,
    };

    public string? Classify(double value)
    {
        if (!Enabled) return null;
        foreach (var level in Sev.Descending)
            if (For(level) is { } t && value >= t) return level;
        return null;
    }

    public double Option(string key, double fallback) => Json.Num(Raw[key]) ?? fallback;
    public List<string> List(string key) => Json.Strs(Raw[key]);
}

sealed class Config
{
    public required JsonObject Root { get; init; }
    public required string Source { get; init; }

    public List<string> Exclude => Json.Strs(Root["exclude"]);
    public List<string> CompositionRoots => Json.Strs(Root["composition_roots"]);
    public List<string> ServiceSuffixes => Json.Strs(Root["service_type_suffixes"]);
    public List<string> NonServiceSuffixes => Json.Strs(Root["non_service_type_suffixes"]);
    public List<string> FactorySuffixes => Json.Strs(Root["factory_type_suffixes"]);

    public Criterion C(string principle, string name)
    {
        var raw = Root["criteria"]?[principle]?[name] as JsonObject ?? [];
        return new Criterion(principle, name, raw.Count > 0 && Json.Bool(raw["enabled"], true),
            Json.Num(raw["low"]), Json.Num(raw["medium"]), Json.Num(raw["high"]), Json.Num(raw["critical"]), raw);
    }

    public IEnumerable<Criterion> AllCriteria() =>
        Principle.All.SelectMany(p => (Root["criteria"]?[p] as JsonObject)?.Select(kv => C(p, kv.Key)) ?? []);

    public JsonObject NumMap(string key)
    {
        var map = new JsonObject();
        if (Root[key] is JsonObject o)
            foreach (var (k, v) in o) map[k] = Json.Num(v) ?? throw new UserError($"'{key}.{k}' must be a number.");
        return map;
    }

    public static Config Load(string repo, string? configPath, string? defaultsPath)
    {
        defaultsPath ??= LocateDefaults();
        if (defaultsPath is null || !File.Exists(defaultsPath))
            throw new UserError("Default thresholds not found. Pass --defaults <skill>/assets/solid-thresholds.default.yaml.");

        var defaults = Json.LoadYaml(defaultsPath);
        var source = $"defaults ({defaultsPath})";

        if (configPath is not null && !File.Exists(configPath))
            throw new UserError($"Config file not found: {configPath}");
        configPath ??= new[] { "solid-thresholds.yaml", "solid-thresholds.yml" }
            .Select(f => Path.Combine(repo, f)).FirstOrDefault(File.Exists);

        var root = defaults;
        if (configPath is not null)
        {
            var overrides = Json.LoadYaml(configPath);
            WarnUnknownKeys(defaults, overrides, configPath);
            root = Json.Merge(defaults, overrides);
            source += $" + overrides ({Path.GetFullPath(configPath)})";
        }

        var config = new Config { Root = root, Source = source };
        foreach (var c in config.AllCriteria())
        {
            var bands = Sev.Ascending.Select(c.For).Where(v => v is not null).Select(v => v!.Value).ToList();
            if (bands.Zip(bands.Skip(1)).Any(p => p.First > p.Second))
                Console.Error.WriteLine($"WARNING: thresholds for {c.Principle}.{c.Name} are not ascending (low <= medium <= high <= critical).");
        }
        return config;
    }

    static string? LocateDefaults()
    {
        var entry = AppContext.GetData("EntryPointFilePath") as string;
        if (entry is null) return null;
        return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(entry)!, "..", "assets", "solid-thresholds.default.yaml"));
    }

    static void WarnUnknownKeys(JsonObject defaults, JsonObject overrides, string path)
    {
        foreach (var (key, _) in overrides)
            if (!defaults.ContainsKey(key))
                Console.Error.WriteLine($"WARNING: {path}: unknown top-level key '{key}' (ignored).");

        if (overrides["criteria"] is not JsonObject oc) return;
        foreach (var (principle, node) in oc)
        {
            if (defaults["criteria"]?[principle] is not JsonObject dp)
            {
                Console.Error.WriteLine($"WARNING: {path}: unknown principle '{principle}'. Expected one of: {string.Join(", ", Principle.All)}.");
                continue;
            }
            if (node is not JsonObject op) continue;
            foreach (var (criterion, _) in op)
                if (!dp.ContainsKey(criterion))
                    Console.Error.WriteLine($"WARNING: {path}: unknown criterion '{principle}.{criterion}'. Known: {string.Join(", ", dp.Select(kv => kv.Key))}.");
        }
    }
}

static class Glob
{
    public static Regex ToRegex(string glob)
    {
        var g = glob.Replace('\\', '/');
        var sb = new StringBuilder("^");
        for (int i = 0; i < g.Length; i++)
        {
            char c = g[i];
            if (c == '*' && i + 1 < g.Length && g[i + 1] == '*')
            {
                bool slash = i + 2 < g.Length && g[i + 2] == '/';
                sb.Append(slash ? "(?:.*/)?" : ".*");
                i += slash ? 2 : 1;
            }
            else if (c == '*') sb.Append("[^/]*");
            else if (c == '?') sb.Append("[^/]");
            else sb.Append(Regex.Escape(c.ToString()));
        }
        return new Regex(sb.Append('$').ToString(), RegexOptions.IgnoreCase);
    }
}

// ---------------------------------------------------------------- Syntax helpers

static class Syn
{
    static readonly Regex InterfaceNaming = new("^I[A-Z]");

    public static bool Has(SyntaxTokenList modifiers, SyntaxKind kind) => modifiers.Any(t => t.IsKind(kind));
    public static int Line(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
    public static bool LooksLikeInterface(string name) => InterfaceNaming.IsMatch(name);

    public static string SimpleName(TypeSyntax? t) => t switch
    {
        null => "",
        GenericNameSyntax g => g.Identifier.Text,
        IdentifierNameSyntax i => i.Identifier.Text,
        QualifiedNameSyntax q => SimpleName(q.Right),
        AliasQualifiedNameSyntax a => SimpleName(a.Name),
        NullableTypeSyntax n => SimpleName(n.ElementType),
        _ => t.ToString(),
    };

    public static string KindOf(TypeDeclarationSyntax d) => d switch
    {
        InterfaceDeclarationSyntax => "interface",
        RecordDeclarationSyntax => "record",
        StructDeclarationSyntax => "struct",
        _ => "class",
    };

    public static string FullName(BaseTypeDeclarationSyntax d)
    {
        var parts = new List<string>();
        foreach (var a in d.AncestorsAndSelf())
        {
            if (a is TypeDeclarationSyntax t)
                parts.Add(t.Identifier.Text + (t.TypeParameterList is { } tp ? $"<{string.Join(",", tp.Parameters.Select(p => p.Identifier.Text))}>" : ""));
            else if (a is EnumDeclarationSyntax e)
                parts.Add(e.Identifier.Text);
            else if (a is BaseNamespaceDeclarationSyntax ns)
                parts.Add(ns.Name.ToString());
        }
        parts.Reverse();
        return string.Join(".", parts);
    }

    public static int CodeLines(SyntaxNode n)
    {
        var text = n.SyntaxTree.GetText();
        var span = text.Lines.GetLinePositionSpan(n.Span);
        int count = 0;
        for (int i = span.Start.Line; i <= span.End.Line; i++)
        {
            var line = text.Lines[i].ToString().Trim();
            if (line.Length > 0 && !line.StartsWith("//") && !line.StartsWith("/*") && !line.StartsWith('*')) count++;
        }
        return count;
    }

    public static (string Name, bool Explicit) MemberName(MemberDeclarationSyntax m) => m switch
    {
        MethodDeclarationSyntax md => (md.Identifier.Text, md.ExplicitInterfaceSpecifier is not null),
        PropertyDeclarationSyntax p => (p.Identifier.Text, p.ExplicitInterfaceSpecifier is not null),
        EventDeclarationSyntax e => (e.Identifier.Text, e.ExplicitInterfaceSpecifier is not null),
        IndexerDeclarationSyntax ix => ("this[]", ix.ExplicitInterfaceSpecifier is not null),
        _ => ("", false),
    };

    // True when the member (or one of its accessors) does nothing but throw NotImplemented/NotSupported.
    public static bool RefusesToImplement(MemberDeclarationSyntax m) => m switch
    {
        MethodDeclarationSyntax md => ThrowOnly(md.Body, md.ExpressionBody),
        PropertyDeclarationSyntax p => ThrowOnly(null, p.ExpressionBody) || AccessorsThrow(p.AccessorList),
        IndexerDeclarationSyntax ix => ThrowOnly(null, ix.ExpressionBody) || AccessorsThrow(ix.AccessorList),
        EventDeclarationSyntax e => AccessorsThrow(e.AccessorList),
        _ => false,
    };

    static bool AccessorsThrow(AccessorListSyntax? list) =>
        list?.Accessors.Any(a => ThrowOnly(a.Body, a.ExpressionBody)) ?? false;

    static bool ThrowOnly(BlockSyntax? body, ArrowExpressionClauseSyntax? arrow) =>
        (arrow?.Expression is ThrowExpressionSyntax te && IsNotImplemented(te.Expression))
        || (body is { Statements.Count: 1 } && body.Statements[0] is ThrowStatementSyntax ts && IsNotImplemented(ts.Expression));

    static bool IsNotImplemented(ExpressionSyntax? e) =>
        e is ObjectCreationExpressionSyntax oc && SimpleName(oc.Type) is "NotImplementedException" or "NotSupportedException";

    public static bool IsTypeCheck(SyntaxNode n, HashSet<string> repoTypes) => n switch
    {
        BinaryExpressionSyntax b => b.IsKind(SyntaxKind.IsExpression) || b.IsKind(SyntaxKind.AsExpression),
        IsPatternExpressionSyntax p => IsTypePattern(p.Pattern, repoTypes),
        CasePatternSwitchLabelSyntax c => IsTypePattern(c.Pattern, repoTypes),
        CaseSwitchLabelSyntax c => IsRepoTypeName(c.Value, repoTypes),
        SwitchExpressionArmSyntax a => IsTypePattern(a.Pattern, repoTypes),
        InvocationExpressionSyntax i => i.Expression is MemberAccessExpressionSyntax { Name.Identifier.Text: "GetType" } && i.ArgumentList.Arguments.Count == 0,
        _ => false,
    };

    static bool IsTypePattern(PatternSyntax p, HashSet<string> repoTypes) => p switch
    {
        DeclarationPatternSyntax or TypePatternSyntax => true,
        RecursivePatternSyntax r => r.Type is not null,
        UnaryPatternSyntax u => IsTypePattern(u.Pattern, repoTypes),
        BinaryPatternSyntax b => IsTypePattern(b.Left, repoTypes) || IsTypePattern(b.Right, repoTypes),
        ParenthesizedPatternSyntax pp => IsTypePattern(pp.Pattern, repoTypes),
        // `case Circle:` / `Circle => ...` parse as constant patterns; only a known type name makes them type checks.
        ConstantPatternSyntax c => IsRepoTypeName(c.Expression, repoTypes),
        _ => false,
    };

    static bool IsRepoTypeName(ExpressionSyntax e, HashSet<string> repoTypes) =>
        e is NameSyntax name && repoTypes.Contains(SimpleName(name));

    public static int ElseIfChain(IfStatementSyntax first)
    {
        int length = 1;
        for (var cur = first; cur.Else?.Statement is IfStatementSyntax next; cur = next) length++;
        return length;
    }
}

sealed class TypeModel
{
    public required string FullName { get; init; }
    public required string Name { get; init; }
    public required string Kind { get; init; }
    public List<(TypeDeclarationSyntax Decl, string File)> Parts { get; } = [];
    public bool IsAbstract { get; set; }
    public bool IsStatic { get; set; }
    public HashSet<string> BaseNames { get; } = [];

    public string PrimaryFile => Parts[0].File;
    public int Line => Parts[0].Decl.Identifier.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    public IEnumerable<MemberDeclarationSyntax> Members =>
        Parts.SelectMany(p => p.Decl.Members).Where(m => m is not BaseTypeDeclarationSyntax and not DelegateDeclarationSyntax);

    public IEnumerable<SyntaxNode> BodyNodes(Func<MemberDeclarationSyntax, bool>? keep = null) =>
        Members.Where(m => keep?.Invoke(m) ?? true).SelectMany(m => m.DescendantNodesAndSelf());

    public IEnumerable<ParameterSyntax> ConstructorParameters =>
        Members.OfType<ConstructorDeclarationSyntax>()
            .Where(c => !Syn.Has(c.Modifiers, SyntaxKind.StaticKeyword))
            .SelectMany(c => c.ParameterList.Parameters)
            .Concat(Parts.SelectMany(p => p.Decl.ParameterList?.Parameters ?? default));
}

sealed record Finding(
    string Id, string Label, string Principle, string Criterion, string Type, string File, int Line,
    double Value, string Severity, double Threshold, string Details)
{
    public string? RegisterStatus { get; init; }
    public bool? CarriedForward { get; init; }
}

// Ids survive edits and file moves: they hash what a finding is about, never where it is.
static class StableId
{
    public static string MetricKey(string principle, string criterion, string type) => $"{principle}|{criterion}|{type}";
    public static string AddedKey(string principle, string type, string title) =>
        $"{principle}|{type}|{Regex.Replace(title.ToLowerInvariant(), "[^a-z0-9]+", " ").Trim()}";

    public static string Of(string key, int length = 6) =>
        "solid-" + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..length];

    // Assigns 6-character ids, widening to 8 for keys whose short ids collide.
    public static List<string> Assign(IReadOnlyList<string> keys)
    {
        var shortIds = keys.Select(k => Of(k)).ToList();
        var collided = shortIds.GroupBy(s => s).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
        return keys.Select((k, i) => collided.Contains(shortIds[i]) ? Of(k, 8) : shortIds[i]).ToList();
    }
}

// Reads a technical debt register (<dir>/items/*.json) so settled findings can skip review.
static class Register
{
    public sealed record Item(string Status, string? Severity);

    public static Dictionary<string, Item> Load(string dir)
    {
        var itemsDir = Path.Combine(dir, "items");
        if (!Directory.Exists(dir)) throw new UserError($"Register directory not found: {dir}");
        var items = new Dictionary<string, Item>(StringComparer.OrdinalIgnoreCase);
        if (!Directory.Exists(itemsDir)) return items;
        foreach (var path in Directory.EnumerateFiles(itemsDir, "*.json"))
        {
            JsonNode? node;
            try { node = JsonNode.Parse(File.ReadAllText(path)); }
            catch (JsonException e) { throw new UserError($"Register item {path} is not valid JSON: {e.Message}"); }
            var id = Json.Str(node?["id"]);
            var status = Json.Str(node?["status"]);
            if (id is null || status is null) throw new UserError($"Register item {path} needs 'id' and 'status'.");
            items[id] = new Item(status, Json.Str(node?["severity"])?.ToLowerInvariant());
        }
        return items;
    }
}

// ---------------------------------------------------------------- projects

sealed class ProjectModel
{
    public required string Name { get; init; }
    public required string Path { get; init; }
    public required string Rel { get; init; }
    public required string Dir { get; init; }
    public List<string> ProjectRefs { get; } = [];
}

static class Projects
{
    static readonly Regex ProjectRef = new("<ProjectReference\\s+Include\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
    static readonly Regex SlnProject = new("^Project\\(\"[^\"]*\"\\)\\s*=\\s*\"[^\"]*\",\\s*\"([^\"]+\\.csproj)\"", RegexOptions.IgnoreCase | RegexOptions.Multiline);
    static readonly Regex SlnxProject = new("<Project\\s+Path\\s*=\\s*\"([^\"]+\\.csproj)\"", RegexOptions.IgnoreCase);
    static readonly EnumerationOptions Recursive = new() { RecurseSubdirectories = true, IgnoreInaccessible = true };

    static string Resolve(string baseDir, string relative) =>
        System.IO.Path.GetFullPath(System.IO.Path.Combine(baseDir, relative.Replace('\\', System.IO.Path.DirectorySeparatorChar)));

    public static List<ProjectModel> Load(string repo, List<Regex> excludes)
    {
        var result = new List<ProjectModel>();
        foreach (var path in Directory.EnumerateFiles(repo, "*.csproj", Recursive))
        {
            var rel = System.IO.Path.GetRelativePath(repo, path).Replace('\\', '/');
            if (excludes.Any(r => r.IsMatch(rel))) continue;
            var full = System.IO.Path.GetFullPath(path);
            var dir = System.IO.Path.GetDirectoryName(full)!;
            var p = new ProjectModel { Name = System.IO.Path.GetFileNameWithoutExtension(path), Path = full, Rel = rel, Dir = dir + System.IO.Path.DirectorySeparatorChar };
            p.ProjectRefs.AddRange(ProjectRef.Matches(File.ReadAllText(path)).Select(m => Resolve(dir, m.Groups[1].Value)));
            result.Add(p);
        }
        return result;
    }

    /// <summary>
    /// Projects that no solution includes and no included project references, directly or transitively: dead or
    /// abandoned code. Empty when the repo has no solution file, because then nothing says what is built.
    /// </summary>
    public static HashSet<string> Orphans(string repo, List<ProjectModel> projects, List<Regex> excludes)
    {
        var byPath = projects.ToDictionary(p => p.Path, StringComparer.OrdinalIgnoreCase);
        var roots = new List<string>();
        foreach (var sln in Directory.EnumerateFiles(repo, "*.sln*", Recursive))
        {
            var rel = System.IO.Path.GetRelativePath(repo, sln).Replace('\\', '/');
            if (excludes.Any(r => r.IsMatch(rel)) || !(sln.EndsWith(".sln", StringComparison.OrdinalIgnoreCase) || sln.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase))) continue;
            var pattern = sln.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase) ? SlnxProject : SlnProject;
            var dir = System.IO.Path.GetDirectoryName(sln)!;
            roots.AddRange(pattern.Matches(File.ReadAllText(sln)).Select(m => Resolve(dir, m.Groups[1].Value)).Where(byPath.ContainsKey));
        }
        if (roots.Count == 0) return [];

        var reached = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<string>(roots);
        while (queue.TryDequeue(out var current))
            if (reached.Add(current) && byPath.TryGetValue(current, out var p))
                foreach (var r in p.ProjectRefs) queue.Enqueue(r);
        return projects.Where(p => !reached.Contains(p.Path)).Select(p => p.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    public static ProjectModel? Owner(List<ProjectModel> projects, string fullFile) =>
        projects.Where(p => fullFile.StartsWith(p.Dir, StringComparison.OrdinalIgnoreCase)).MaxBy(p => p.Dir.Length);
}

// ---------------------------------------------------------------- analyze

static class Analyzer
{
    public static int Run(List<string> positional, Dictionary<string, string> opts)
    {
        if (positional.Count == 0) throw new UserError("analyze needs a repository path.");
        var repo = Path.GetFullPath(positional[0]);
        if (!Directory.Exists(repo)) throw new UserError($"Repository path not found: {repo}");

        var config = Config.Load(repo, opts.GetValueOrDefault("config"), opts.GetValueOrDefault("defaults"));
        var outPath = Path.GetFullPath(opts.GetValueOrDefault("out") ?? Path.Combine(repo, ".solid-analysis", "solid-metrics.json"));

        var excludes = config.Exclude.Select(Glob.ToRegex).ToList();
        var roots = config.CompositionRoots.Select(Glob.ToRegex).ToList();
        var enumeration = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true };
        var allFiles = Directory.EnumerateFiles(repo, "*.cs", enumeration)
            .Select(f => (Full: f, Rel: Path.GetRelativePath(repo, f).Replace('\\', '/')))
            .ToList();
        var files = allFiles.Where(f => !excludes.Any(r => r.IsMatch(f.Rel))).ToList();

        // Projects nothing builds are dead code: their findings would only be noise.
        var projects = Projects.Load(repo, excludes);
        var orphans = Json.Bool(config.Root["exclude_orphan_projects"], true) ? Projects.Orphans(repo, projects, excludes) : [];
        var owners = files.ToDictionary(f => f.Rel, f => Projects.Owner(projects, Path.GetFullPath(f.Full)));
        var orphanProjects = projects.Where(p => orphans.Contains(p.Path)).Select(p => p.Rel).OrderBy(r => r, StringComparer.Ordinal).ToList();
        int orphanFileCount = files.Count(f => owners[f.Rel] is { } o && orphans.Contains(o.Path));
        files = files.Where(f => !(owners[f.Rel] is { } o && orphans.Contains(o.Path))).ToList();
        if (files.Count == 0)
            throw new UserError($"No C# files to analyze under {repo} ({allFiles.Count} .cs files found, all excluded). Check the 'exclude' patterns.");

        // Pass 1: build the type model (partial declarations merged by full name).
        var types = new Dictionary<string, TypeModel>();
        var enums = new Dictionary<string, string>();
        var parseErrorFiles = new List<string>();
        foreach (var (full, rel) in files)
        {
            var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(full), path: rel);
            if (tree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error)) parseErrorFiles.Add(rel);
            var root = tree.GetRoot();
            foreach (var e in root.DescendantNodes().OfType<EnumDeclarationSyntax>()) enums.TryAdd(e.Identifier.Text, Syn.FullName(e));
            foreach (var decl in root.DescendantNodes().OfType<TypeDeclarationSyntax>())
            {
                var name = Syn.FullName(decl);
                if (!types.TryGetValue(name, out var t))
                    types[name] = t = new TypeModel { FullName = name, Name = decl.Identifier.Text, Kind = Syn.KindOf(decl) };
                t.Parts.Add((decl, rel));
                t.IsAbstract |= Syn.Has(decl.Modifiers, SyntaxKind.AbstractKeyword);
                t.IsStatic |= Syn.Has(decl.Modifiers, SyntaxKind.StaticKeyword);
                foreach (var b in decl.BaseList?.Types ?? default) t.BaseNames.Add(Syn.SimpleName(b.Type));
            }
        }

        var interfaces = types.Values.Where(t => t.Kind == "interface")
            .GroupBy(t => t.Name)
            .ToDictionary(g => g.Key, g => g.SelectMany(t => t.Members).Select(m => Syn.MemberName(m).Name).ToHashSet());
        bool IsInterface(string name) => interfaces.ContainsKey(name) || Syn.LooksLikeInterface(name);

        var repoTypeNames = types.Values.Select(t => t.Name).ToHashSet();
        var serviceSuffixes = config.ServiceSuffixes;
        var nonServiceSuffixes = config.NonServiceSuffixes;
        // An interface only marks its implementers as services if something in the repo injects it;
        // marker and framework-callback interfaces (IEntity, IFilter, IEventListener) do not.
        var injectedInterfaces = types.Values.SelectMany(t => t.ConstructorParameters)
            .Select(p => Syn.SimpleName(p.Type)).Where(IsInterface).ToHashSet();
        var serviceNames = types.Values
            .Where(t => t.Kind == "class" && !t.IsAbstract && !t.IsStatic
                && !nonServiceSuffixes.Any(s => t.Name.EndsWith(s, StringComparison.Ordinal))
                && (t.BaseNames.Any(injectedInterfaces.Contains) || serviceSuffixes.Any(s => t.Name.EndsWith(s, StringComparison.Ordinal))))
            .Select(t => t.Name)
            .ToHashSet();
        bool IsDependency(ParameterSyntax p) => Syn.SimpleName(p.Type) is var n && (IsInterface(n) || serviceNames.Contains(n));

        // Pass 2: metrics and findings.
        var findings = new List<Finding>();
        void Check(Criterion c, TypeModel t, double value, string details, SyntaxNode? at = null, (string Severity, string Reason)? cap = null)
        {
            if (c.Classify(value) is not { } severity) return;
            if (cap is { } limit && Sev.Rank(severity) > Sev.Rank(limit.Severity) && c.For(limit.Severity) is not null)
            {
                details += $" (capped at {limit.Severity}: {limit.Reason})";
                severity = limit.Severity;
            }
            findings.Add(new Finding("", "", c.Principle, c.Name, t.FullName,
                at?.SyntaxTree.FilePath ?? t.PrimaryFile, at is null ? t.Line : Syn.Line(at),
                Math.Round(value, 2), severity, c.For(severity)!.Value, details));
        }

        // Domain entities and aggregates hold many small per-property mutators, which LCOM reads as low cohesion.
        var entityBases = config.C("srp", "lcom").List("entity_base_types").ToHashSet();
        var classesByName = types.Values.Where(t => t.Kind == "class").GroupBy(t => t.Name).ToDictionary(g => g.Key, g => g.First());
        bool IsEntity(TypeModel t, int depth = 0) => depth < 10 && t.BaseNames.Any(b =>
            entityBases.Contains(b) || (classesByName.TryGetValue(b, out var bt) && bt != t && IsEntity(bt, depth + 1)));
        var entityCap = Json.Str(config.C("srp", "lcom").Raw["entity_max_severity"]);
        if (entityCap is not null && !Sev.Valid(entityCap)) throw new UserError($"srp.lcom.entity_max_severity must be one of: {string.Join(", ", Sev.Ascending)}.");

        var switchesByEnum = new Dictionary<string, List<(string Type, SyntaxNode Node)>>();
        static string? EnumOf(ExpressionSyntax? e) => e is MemberAccessExpressionSyntax m
            ? m.Expression switch { IdentifierNameSyntax i => i.Identifier.Text, MemberAccessExpressionSyntax mm => mm.Name.Identifier.Text, _ => null }
            : null;
        static string Lines(IEnumerable<SyntaxNode> nodes, int max = 8)
        {
            var lines = nodes.Select(Syn.Line).Distinct().ToList();
            return string.Join(", ", lines.Take(max)) + (lines.Count > max ? ", ..." : "");
        }

        foreach (var t in types.Values)
        {
            bool concrete = t.Kind is "class" or "record" or "struct";
            bool isClass = t.Kind == "class";
            bool compositionRoot = t.Parts.Any(p => roots.Any(r => r.IsMatch(p.File)));
            bool factory = config.FactorySuffixes.Any(s => t.Name.EndsWith(s, StringComparison.Ordinal));

            // ---- SRP
            if (concrete)
            {
                var lines = t.Parts.Sum(p => Syn.CodeLines(p.Decl));
                Check(config.C("srp", "class_lines"), t, lines, $"{lines} code lines (blank and comment lines excluded) across {t.Parts.Count} declaration(s)");

                var publicMethods = t.Members.OfType<MethodDeclarationSyntax>()
                    .Count(m => Syn.Has(m.Modifiers, SyntaxKind.PublicKeyword)
                        && !(Syn.Has(m.Modifiers, SyntaxKind.OverrideKeyword) && m.Identifier.Text is "ToString" or "Equals" or "GetHashCode"));
                Check(config.C("srp", "public_methods"), t, publicMethods, $"{publicMethods} public methods");
            }
            if (isClass && !t.IsStatic)
            {
                // Only injected abstractions and services count; data parameters (ids, names, DTOs) are not dependencies.
                var widest = t.Members.OfType<ConstructorDeclarationSyntax>()
                    .Where(c => !Syn.Has(c.Modifiers, SyntaxKind.StaticKeyword))
                    .Select(c => c.ParameterList.Parameters)
                    .Concat(t.Parts.Select(p => p.Decl.ParameterList?.Parameters ?? default))
                    .Select(ps => (Deps: ps.Count(IsDependency), Total: ps.Count))
                    .DefaultIfEmpty((Deps: 0, Total: 0)).MaxBy(x => x.Deps);
                Check(config.C("srp", "constructor_dependencies"), t, widest.Deps,
                    $"widest constructor takes {widest.Deps} injected dependencies (interfaces or services) out of {widest.Total} parameters");

                // State = instance fields, auto-properties, and primary constructor parameters. A method that reads a
                // computed property is credited with the state that property reads.
                var lcom = config.C("srp", "lcom");
                var properties = t.Members.OfType<PropertyDeclarationSyntax>().Where(p => !Syn.Has(p.Modifiers, SyntaxKind.StaticKeyword)).ToList();
                static bool IsAuto(PropertyDeclarationSyntax p) =>
                    p.ExpressionBody is null && p.AccessorList is { } al && al.Accessors.All(a => a.Body is null && a.ExpressionBody is null);
                static HashSet<string> Identifiers(SyntaxNode n) => n.DescendantNodes().OfType<IdentifierNameSyntax>().Select(i => i.Identifier.Text).ToHashSet();
                var computed = properties.Where(p => !IsAuto(p)).GroupBy(p => p.Identifier.Text).ToDictionary(g => g.Key, g => Identifiers(g.First()));
                var methods = t.Members.OfType<MethodDeclarationSyntax>()
                    .Where(m => !Syn.Has(m.Modifiers, SyntaxKind.StaticKeyword) && (m.Body is not null || m.ExpressionBody is not null))
                    .ToList();
                var used = methods.Select(m =>
                {
                    var ids = Identifiers(m);
                    foreach (var name in ids.Where(computed.ContainsKey).ToList()) ids.UnionWith(computed[name]);
                    return ids;
                }).ToList();
                // Auto-properties no method touches are data surface (binding, persistence), not state that methods share.
                var fields = t.Members.OfType<FieldDeclarationSyntax>()
                    .Where(f => !Syn.Has(f.Modifiers, SyntaxKind.StaticKeyword) && !Syn.Has(f.Modifiers, SyntaxKind.ConstKeyword))
                    .SelectMany(f => f.Declaration.Variables.Select(v => v.Identifier.Text))
                    .Concat(properties.Where(IsAuto).Select(p => p.Identifier.Text).Where(name => used.Any(u => u.Contains(name))))
                    .Concat(t.Parts.SelectMany(p => p.Decl.ParameterList?.Parameters.Select(x => x.Identifier.Text) ?? []))
                    .Distinct().ToList();
                if (methods.Count >= lcom.Option("min_methods", 4) && fields.Count >= lcom.Option("min_fields", 2))
                {
                    double avg = fields.Average(f => used.Count(u => u.Contains(f)));
                    double value = Math.Clamp((methods.Count - avg) / (methods.Count - 1), 0, 1);
                    Check(lcom, t, value, $"LCOM-HS {value:0.00}: {methods.Count} instance methods, {fields.Count} fields and auto-properties; each is used by {avg:0.#} method(s) on average",
                        cap: entityCap is not null && IsEntity(t) ? (entityCap, "domain entity") : null);
                }
            }

            // ---- OCP
            if (concrete)
            {
                var nodes = t.BodyNodes().ToList();

                int maxArms = 0;
                SyntaxNode? armsAt = null;
                foreach (var n in nodes)
                {
                    int arms = n switch
                    {
                        SwitchStatementSyntax s => s.Sections.Count(sec => !sec.Labels.All(l => l is DefaultSwitchLabelSyntax)),
                        SwitchExpressionSyntax e => e.Arms.Count(a => a.Pattern is not DiscardPatternSyntax),
                        _ => 0,
                    };
                    if (arms > maxArms) { maxArms = arms; armsAt = n; }

                    var labels = n switch
                    {
                        SwitchStatementSyntax s => s.Sections.SelectMany(sec => sec.Labels).Select(l => l switch
                        {
                            CaseSwitchLabelSyntax c => c.Value,
                            CasePatternSwitchLabelSyntax { Pattern: ConstantPatternSyntax cp } => cp.Expression,
                            _ => null,
                        }),
                        SwitchExpressionSyntax e => e.Arms.Select(a => a.Pattern is ConstantPatternSyntax cp ? cp.Expression : null),
                        _ => null,
                    };
                    var subject = labels?.Select(EnumOf).Where(x => x is not null && enums.ContainsKey(x))
                        .GroupBy(x => x!).Where(g => g.Count() >= 2).MaxBy(g => g.Count())?.Key;
                    if (subject is not null)
                    {
                        if (!switchesByEnum.TryGetValue(subject, out var uses)) switchesByEnum[subject] = uses = [];
                        uses.Add((t.FullName, n));
                    }
                }
                if (armsAt is not null)
                    Check(config.C("ocp", "max_switch_arms"), t, maxArms, $"largest switch has {maxArms} non-default cases", armsAt);

                var typeChecks = t.BodyNodes(m => !(m is MethodDeclarationSyntax md && md.Identifier.Text is "Equals" or "CompareTo"))
                    .Where(n => Syn.IsTypeCheck(n, repoTypeNames)).ToList();
                if (typeChecks.Count > 0)
                    Check(config.C("ocp", "type_checks"), t, typeChecks.Count, $"{typeChecks.Count} runtime type checks (is/as/type patterns/GetType) at lines {Lines(typeChecks)}", typeChecks[0]);

                var chains = nodes.OfType<IfStatementSyntax>().Where(i => i.Parent is not ElseClauseSyntax)
                    .Select(i => (Node: i, Length: Syn.ElseIfChain(i))).OrderByDescending(x => x.Length).FirstOrDefault();
                if (chains.Node is not null)
                    Check(config.C("ocp", "else_if_chain"), t, chains.Length, $"longest if/else-if chain has {chains.Length} branches", chains.Node);
            }

            // ---- LSP + ISP (members that refuse to implement)
            if (concrete)
            {
                var implemented = t.BaseNames.Where(IsInterface).ToList();
                var repoInterfaceMembers = implemented.Where(interfaces.ContainsKey).SelectMany(i => interfaces[i]).ToHashSet();
                bool hasExternalInterface = implemented.Any(i => !interfaces.ContainsKey(i));
                var lspRefused = new List<MemberDeclarationSyntax>();
                var ispRefused = new List<MemberDeclarationSyntax>();
                foreach (var m in t.Members.Where(Syn.RefusesToImplement))
                {
                    var (name, isExplicit) = Syn.MemberName(m);
                    if (Syn.Has(m.Modifiers, SyntaxKind.OverrideKeyword)) lspRefused.Add(m);
                    else if (isExplicit || (Syn.Has(m.Modifiers, SyntaxKind.PublicKeyword) && (repoInterfaceMembers.Contains(name) || hasExternalInterface)))
                        ispRefused.Add(m);
                }
                string Names(List<MemberDeclarationSyntax> ms) => string.Join(", ", ms.Select(m => $"{Syn.MemberName(m).Name} (line {Syn.Line(m)})"));
                if (lspRefused.Count > 0)
                    Check(config.C("lsp", "not_implemented_overrides"), t, lspRefused.Count, $"overrides that only throw NotImplemented/NotSupported: {Names(lspRefused)}", lspRefused[0]);
                if (ispRefused.Count > 0)
                    Check(config.C("isp", "not_implemented_interface_members"), t, ispRefused.Count, $"interface members that only throw NotImplemented/NotSupported: {Names(ispRefused)}", ispRefused[0]);

                var hidden = t.Members.Where(m => Syn.Has(m.Modifiers, SyntaxKind.NewKeyword)).ToList();
                if (hidden.Count > 0)
                    Check(config.C("lsp", "hidden_members"), t, hidden.Count, $"members hiding base members with 'new' at lines {Lines(hidden)}", hidden[0]);

                var empty = t.Members.OfType<MethodDeclarationSyntax>()
                    .Where(m => Syn.Has(m.Modifiers, SyntaxKind.OverrideKeyword) && m.Body is { Statements.Count: 0 }).ToList();
                if (empty.Count > 0)
                    Check(config.C("lsp", "empty_overrides"), t, empty.Count, $"overrides with empty bodies: {string.Join(", ", empty.Select(m => $"{m.Identifier.Text} (line {Syn.Line(m)})"))}", empty[0]);
            }

            // ---- ISP (interface width)
            if (t.Kind == "interface")
            {
                var members = t.Members.Count(m => m is MethodDeclarationSyntax or BasePropertyDeclarationSyntax or EventFieldDeclarationSyntax);
                Check(config.C("isp", "interface_members"), t, members, $"{members} members (methods, properties, events, indexers)");
            }

            // ---- DIP
            if (isClass && !compositionRoot)
            {
                if (!factory)
                {
                    var news = t.BodyNodes().OfType<ObjectCreationExpressionSyntax>()
                        .Where(o => Syn.SimpleName(o.Type) is var n && serviceNames.Contains(n) && n != t.Name).ToList();
                    if (news.Count > 0)
                        Check(config.C("dip", "concrete_instantiations"), t, news.Count,
                            $"`new` of concrete service classes: {string.Join(", ", news.Select(o => Syn.SimpleName(o.Type)).Distinct())} (lines {Lines(news)})", news[0]);
                }

                var concreteDeps = t.ConstructorParameters.Select(p => Syn.SimpleName(p.Type)).Where(serviceNames.Contains).Distinct().ToList();
                if (concreteDeps.Count > 0)
                    Check(config.C("dip", "concrete_constructor_dependencies"), t, concreteDeps.Count,
                        $"constructor depends on concrete classes instead of abstractions: {string.Join(", ", concreteDeps)}");

                var infra = config.C("dip", "hard_coded_infrastructure");
                var memberPatterns = infra.List("member_patterns");
                var newTypes = infra.List("new_types").ToHashSet();
                var hits = t.BodyNodes().Where(n =>
                        (n is MemberAccessExpressionSyntax ma && memberPatterns.Any(p => p.EndsWith(".*") ? ma.Expression.ToString() == p[..^2] : ma.ToString() == p))
                        || (n is ObjectCreationExpressionSyntax oc && newTypes.Contains(Syn.SimpleName(oc.Type))))
                    .ToList();
                if (hits.Count > 0)
                {
                    var what = hits.Select(h => h is ObjectCreationExpressionSyntax oc ? $"new {Syn.SimpleName(oc.Type)}" : h.ToString()).Distinct().Take(6);
                    Check(infra, t, hits.Count, $"{hits.Count} direct uses of infrastructure: {string.Join(", ", what)} (lines {Lines(hits)})", hits[0]);
                }
            }
        }

        // ---- OCP: the same enum switched on in several types (every new variant means editing all of them)
        var duplicated = config.C("ocp", "duplicated_switch");
        foreach (var (enumName, uses) in switchesByEnum)
        {
            var users = uses.Select(u => u.Type).Distinct().ToList();
            if (duplicated.Classify(users.Count) is not { } severity) continue;
            var at = uses[0].Node;
            var where = uses.Select(u => $"{u.Type.Split('.')[^1]} ({u.Node.SyntaxTree.FilePath}:{Syn.Line(u.Node)})").ToList();
            findings.Add(new Finding("", "", "ocp", "duplicated_switch", enums[enumName], at.SyntaxTree.FilePath, Syn.Line(at), users.Count, severity,
                duplicated.For(severity)!.Value, $"{uses.Count} switches over {enumName} in {users.Count} types: {string.Join(", ", where.Take(8))}{(where.Count > 8 ? ", ..." : "")}"));
        }

        // Labels (SRP-001) are for reading this run's report; ids are stable across runs.
        var counters = Principle.All.ToDictionary(p => p, _ => 0);
        var ordered = findings
            .OrderBy(f => Array.IndexOf(Principle.All, f.Principle))
            .ThenByDescending(f => Sev.Rank(f.Severity))
            .ThenByDescending(f => f.Threshold == 0 ? f.Value : f.Value / f.Threshold)
            .ThenBy(f => f.Type, StringComparer.Ordinal)
            .ToList();
        var ids = StableId.Assign(ordered.Select(f => StableId.MetricKey(f.Principle, f.Criterion, f.Type)).ToList());
        var register = opts.GetValueOrDefault("register") is { } registerDir ? Register.Load(registerDir) : null;
        var sorted = ordered.Select((f, i) =>
        {
            var labeled = f with { Id = ids[i], Label = $"{f.Principle.ToUpperInvariant()}-{++counters[f.Principle]:000}" };
            if (register?.GetValueOrDefault(ids[i]) is not { } item) return labeled;
            bool settled = item.Status is "accepted" or "dismissed";
            return labeled with
            {
                RegisterStatus = item.Status,
                CarriedForward = settled && (item.Severity is null || Sev.Rank(f.Severity) <= Sev.Rank(item.Severity)),
            };
        }).ToList();

        var jsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            WriteIndented = true,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        };
        var doc = new JsonObject
        {
            ["generated_utc"] = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm 'UTC'"),
            ["repo_path"] = repo,
            ["application"] = Path.GetFileName(repo.TrimEnd('\\', '/')),
            ["config_source"] = config.Source,
            ["stats"] = new JsonObject
            {
                ["cs_files_found"] = allFiles.Count,
                ["files_analyzed"] = files.Count,
                ["files_excluded"] = allFiles.Count - files.Count,
                ["files_with_parse_errors"] = JsonSerializer.SerializeToNode(parseErrorFiles),
                ["projects_found"] = projects.Count,
                ["orphan_projects"] = JsonSerializer.SerializeToNode(orphanProjects),
                ["files_in_orphan_projects"] = orphanFileCount,
                ["types_analyzed"] = types.Count,
                ["types_by_kind"] = new JsonObject(types.Values.GroupBy(t => t.Kind).Select(g => KeyValuePair.Create(g.Key, (JsonNode?)g.Count()))),
            },
            ["scoring"] = new JsonObject
            {
                ["severity_points"] = config.NumMap("severity_points"),
                ["rating_bands"] = config.NumMap("rating_bands"),
                ["principle_weights"] = config.NumMap("principle_weights"),
            },
            ["thresholds"] = new JsonArray(config.AllCriteria().Select(c => (JsonNode)new JsonObject
            {
                ["principle"] = c.Principle,
                ["criterion"] = c.Name,
                ["enabled"] = c.Enabled,
                ["low"] = c.Low,
                ["medium"] = c.Medium,
                ["high"] = c.High,
                ["critical"] = c.Critical,
            }).ToArray()),
            ["findings"] = JsonSerializer.SerializeToNode(sorted, jsonOptions),
        };
        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        File.WriteAllText(outPath, doc.ToJsonString(jsonOptions));

        PrintSummary(repo, config, files.Count, allFiles.Count - files.Count, types.Count, parseErrorFiles, orphanProjects, sorted, outPath);
        return 0;
    }

    static void PrintSummary(string repo, Config config, int analyzed, int excluded, int typeCount, List<string> parseErrors, List<string> orphanProjects, List<Finding> findings, string outPath)
    {
        Console.WriteLine($"Repository: {repo}");
        Console.WriteLine($"Thresholds: {config.Source}");
        Console.WriteLine($"Analyzed {analyzed} files ({excluded} excluded), {typeCount} types.");
        if (orphanProjects.Count > 0)
            Console.WriteLine($"Skipped {orphanProjects.Count} project(s) no solution builds: {string.Join(", ", orphanProjects)}");
        if (parseErrors.Count > 0)
            Console.WriteLine($"WARNING: {parseErrors.Count} file(s) have syntax errors; their metrics may be incomplete: {string.Join(", ", parseErrors.Take(5))}");

        string Counts(IEnumerable<Finding> fs) => string.Join("  ", Sev.Descending.Select(s => $"{s} {fs.Count(f => f.Severity == s)}"));
        Console.WriteLine($"\nFindings: {findings.Count}  ({Counts(findings)})");
        foreach (var p in Principle.All)
            Console.WriteLine($"  {p.ToUpperInvariant()}  {Counts(findings.Where(f => f.Principle == p))}");

        int carried = findings.Count(f => f.CarriedForward == true);
        if (carried > 0)
            Console.WriteLine($"{carried} finding(s) are accepted or dismissed in the register and carried forward without review.");

        var top = findings.OrderByDescending(f => Sev.Rank(f.Severity)).ThenBy(f => f.Label).Take(25).ToList();
        if (top.Count > 0)
        {
            Console.WriteLine($"\nTop {top.Count} findings:");
            foreach (var f in top)
                Console.WriteLine($"  [{f.Severity.ToUpperInvariant(),-8}] {f.Label} {f.Id}  {f.Criterion} = {Fmt.Num(f.Value)} (>= {Fmt.Num(f.Threshold)})  {f.Type}  {f.File}:{f.Line}");
        }
        Console.WriteLine($"\nMetrics written to: {outPath}");
    }
}

// ---------------------------------------------------------------- report

sealed class ReportFinding
{
    public required string Id { get; init; }
    public required string Label { get; init; }
    public required string Principle { get; init; }
    public required string Criterion { get; init; }
    public required string Type { get; init; }
    public required string File { get; init; }
    public int Line { get; init; }
    public double? Value { get; init; }
    public double? Threshold { get; init; }
    public required string Severity { get; set; }
    public required string OriginalSeverity { get; init; }
    public required string Details { get; init; }
    public bool FromReview { get; init; }
    public bool Dismissed { get; set; }
    public string? Reason { get; set; }
    public string? Recommendation { get; set; }
    public List<string> Evidence { get; set; } = [];
    public List<string> Related { get; set; } = [];
    public string? RegisterStatus { get; init; }
    public bool CarriedForward { get; init; }
}

static class Reporter
{
    public static int Run(Dictionary<string, string> opts)
    {
        var metricsPath = opts.GetValueOrDefault("metrics") ?? throw new UserError("report needs --metrics <solid-metrics.json>.");
        if (!File.Exists(metricsPath)) throw new UserError($"Metrics file not found: {metricsPath}. Run 'analyze' first.");
        var metrics = JsonNode.Parse(File.ReadAllText(metricsPath)) as JsonObject ?? throw new UserError($"{metricsPath} is not a JSON object.");
        var outPath = Path.GetFullPath(opts.GetValueOrDefault("out") ?? Path.Combine(Path.GetDirectoryName(Path.GetFullPath(metricsPath))!, "SOLID-RISK-PROFILE.md"));

        var findings = (metrics["findings"] as JsonArray ?? []).Select(n => new ReportFinding
        {
            Id = Json.Str(n!["id"])!,
            Label = Json.Str(n["label"]) ?? Json.Str(n["id"])!,
            Principle = Json.Str(n["principle"])!,
            Criterion = Json.Str(n["criterion"])!,
            Type = Json.Str(n["type"])!,
            File = Json.Str(n["file"])!,
            Line = (int)(Json.Num(n["line"]) ?? 0),
            Value = Json.Num(n["value"]),
            Threshold = Json.Num(n["threshold"]),
            Severity = Json.Str(n["severity"])!,
            OriginalSeverity = Json.Str(n["severity"])!,
            Details = Json.Str(n["details"]) ?? "",
            RegisterStatus = Json.Str(n["register_status"]),
            CarriedForward = Json.Bool(n["carried_forward"], false),
        }).ToList();
        foreach (var f in findings.Where(f => f.CarriedForward && f.RegisterStatus == "dismissed"))
        {
            f.Dismissed = true;
            f.Reason = "Dismissed in the technical debt register; carried forward without review.";
        }

        var repoPath = Json.Str(metrics["repo_path"]);
        var review = new ReviewData();
        if (opts.GetValueOrDefault("review") is { } reviewPath)
        {
            if (!File.Exists(reviewPath)) throw new UserError($"Review file not found: {reviewPath}");
            JsonNode? reviewJson;
            try { reviewJson = JsonNode.Parse(File.ReadAllText(reviewPath)); }
            catch (JsonException e) { throw new UserError($"{reviewPath} is not valid JSON: {e.Message}"); }
            var errors = ApplyReview(reviewJson, findings, review, repoPath);
            if (errors.Count > 0)
            {
                Console.Error.WriteLine($"Review file has {errors.Count} problem(s); no report written:");
                foreach (var e in errors) Console.Error.WriteLine($"  - {e}");
                return 2;
            }
        }

        var rollup = Rollup.Compute(metrics, findings.Where(f => !f.Dismissed).ToList());
        File.WriteAllText(outPath, Render(metrics, findings, review, rollup));

        Console.WriteLine($"Overall risk: {rollup.Overall.ToUpperInvariant()} (weighted density {rollup.OverallDensity:0.0})");
        foreach (var p in Principle.All)
            Console.WriteLine($"  {p.ToUpperInvariant()}  {rollup.Ratings[p].ToUpperInvariant(),-8} density {rollup.Densities[p]:0.0}");
        Console.WriteLine($"Kept {findings.Count(f => !f.Dismissed)} findings, dismissed {findings.Count(f => f.Dismissed)}, added {findings.Count(f => f.FromReview)} from review.");
        Console.WriteLine($"Report written to: {outPath}");
        return 0;
    }

    sealed class ReviewData
    {
        public string? Application;
        public string? ExecutiveSummary;
        public List<string> Recommendations = [];
    }

    // Optional `evidence: [{file, line, note}]`; files must exist in the analyzed repo and lines must be in range.
    static List<string> ReadEvidence(JsonNode? node, string where, string? repoPath, List<string> errors)
    {
        var result = new List<string>();
        if (node is null) return result;
        if (node is not JsonArray items) { errors.Add($"{where}: 'evidence' must be an array of {{file, line, note}}."); return result; }
        for (int i = 0; i < items.Count; i++)
        {
            var file = Json.Str(items[i]?["file"]);
            var line = (int)(Json.Num(items[i]?["line"]) ?? 0);
            var note = Json.Str(items[i]?["note"]);
            if (string.IsNullOrWhiteSpace(file)) { errors.Add($"{where}.evidence[{i}]: 'file' is required."); continue; }
            if (repoPath is not null)
            {
                var full = Path.Combine(repoPath, file);
                if (!File.Exists(full)) { errors.Add($"{where}.evidence[{i}]: file '{file}' does not exist in {repoPath}."); continue; }
                if (line > 0 && line > File.ReadLines(full).Count()) { errors.Add($"{where}.evidence[{i}]: line {line} is past the end of '{file}'."); continue; }
            }
            result.Add((line > 0 ? $"`{file}:{line}`" : $"`{file}`") + (string.IsNullOrWhiteSpace(note) ? "" : $" {note}"));
        }
        return result;
    }

    static List<string> ApplyReview(JsonNode? json, List<ReportFinding> findings, ReviewData review, string? repoPath)
    {
        var errors = new List<string>();
        if (json is not JsonObject root) return ["The review file must be a JSON object."];

        review.Application = Json.Str(root["application"]);
        review.ExecutiveSummary = Json.Str(root["executive_summary"]);
        if (string.IsNullOrWhiteSpace(review.ExecutiveSummary)) errors.Add("'executive_summary' is required: 2-5 sentences on the overall risk and what drives it.");
        review.Recommendations = Json.Strs(root["recommendations"]);

        var byId = new Dictionary<string, ReportFinding>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in findings) { byId[f.Id] = f; byId[f.Label] = f; }
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var reviewed = root["reviewed"] as JsonArray ?? [];
        for (int i = 0; i < reviewed.Count; i++)
        {
            var item = reviewed[i] as JsonObject;
            var where = $"reviewed[{i}]";
            var id = Json.Str(item?["id"]);
            if (id is null) { errors.Add($"{where}: missing 'id'."); continue; }
            if (!byId.TryGetValue(id, out var f))
            {
                var prefix = id.Split('-')[0].ToUpperInvariant();
                var known = findings.Where(x => x.Label.StartsWith(prefix + "-")).Select(x => x.Label).ToList();
                errors.Add($"{where}: unknown finding id '{id}'. Use the finding's 'id' (solid-xxxxxx) or its 'label'." +
                    (known.Count > 0 ? $" {prefix} labels run from {known[0]} to {known[^1]}." : ""));
                continue;
            }
            if (!seen.Add(f.Id)) { errors.Add($"{where}: '{id}' ({f.Label}) is reviewed more than once."); continue; }
            f.Evidence = ReadEvidence(item!["evidence"], where, repoPath, errors);
            f.Related = Json.Strs(item["related"]);

            var action = Json.Str(item!["action"]);
            var reason = Json.Str(item["reason"]);
            f.Recommendation = Json.Str(item["recommendation"]);
            f.Reason = reason;
            switch (action)
            {
                case "keep":
                    break;
                case "dismiss":
                    if (string.IsNullOrWhiteSpace(reason)) errors.Add($"{where} ({id}): 'dismiss' needs a 'reason' explaining why it is a false positive.");
                    f.Dismissed = true;
                    break;
                case "adjust":
                    var severity = Json.Str(item["severity"]);
                    if (!Sev.Valid(severity)) errors.Add($"{where} ({id}): 'adjust' needs 'severity' set to one of: {string.Join(", ", Sev.Ascending)} (got '{severity}').");
                    else f.Severity = severity!;
                    if (string.IsNullOrWhiteSpace(reason)) errors.Add($"{where} ({id}): 'adjust' needs a 'reason'.");
                    break;
                default:
                    errors.Add($"{where} ({id}): 'action' must be keep, dismiss, or adjust (got '{action}').");
                    break;
            }
        }

        var added = root["added"] as JsonArray ?? [];
        var counters = Principle.All.ToDictionary(p => p, _ => 0);
        for (int i = 0; i < added.Count; i++)
        {
            var item = added[i] as JsonObject;
            var where = $"added[{i}]";
            if (item is null) { errors.Add($"{where}: must be an object."); continue; }
            var principle = Json.Str(item["principle"])?.ToLowerInvariant();
            var severity = Json.Str(item["severity"])?.ToLowerInvariant();
            var title = Json.Str(item["title"]);
            var type = Json.Str(item["type"]);
            var file = Json.Str(item["file"]);
            var details = Json.Str(item["details"]);
            if (principle is null || !Principle.All.Contains(principle)) errors.Add($"{where}: 'principle' must be one of: {string.Join(", ", Principle.All)} (got '{principle}').");
            if (!Sev.Valid(severity)) errors.Add($"{where}: 'severity' must be one of: {string.Join(", ", Sev.Ascending)} (got '{severity}').");
            foreach (var (key, value) in new[] { ("title", title), ("type", type), ("file", file), ("details", details) })
                if (string.IsNullOrWhiteSpace(value)) errors.Add($"{where}: '{key}' is required.");
            if (!string.IsNullOrWhiteSpace(file) && !file.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                errors.Add($"{where}: SOLID findings are about types: 'file' must be the .cs file that declares '{type}' (got '{file}'). Project, solution, and architecture concerns are out of scope.");
            var evidence = ReadEvidence(item["evidence"], where, repoPath, errors);
            if (errors.Count > 0 && (principle is null || !Principle.All.Contains(principle) || !Sev.Valid(severity))) continue;

            var id = Json.Str(item["id"]) ?? StableId.Of(StableId.AddedKey(principle!, type ?? "", title ?? ""));
            if (findings.Any(x => x.Id.Equals(id, StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add($"{where}: id '{id}' is already used by another finding; give it a different title or an explicit 'id'.");
                continue;
            }
            findings.Add(new ReportFinding
            {
                Id = id,
                Label = $"{principle!.ToUpperInvariant()}-R{++counters[principle]:00}",
                Evidence = evidence,
                Principle = principle,
                Criterion = title ?? "",
                Type = type ?? "",
                File = file ?? "",
                Line = (int)(Json.Num(item["line"]) ?? 0),
                Severity = severity!,
                OriginalSeverity = severity!,
                Details = details ?? "",
                Recommendation = Json.Str(item["recommendation"]),
                Related = Json.Strs(item["related"]),
                FromReview = true,
            });
        }

        // `related` may name any finding, metric or added, by id or label.
        var allById = new Dictionary<string, ReportFinding>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in findings) { allById[f.Id] = f; allById[f.Label] = f; }
        foreach (var f in findings.Where(f => f.Related.Count > 0))
        {
            foreach (var r in f.Related.Where(r => !allById.ContainsKey(r))) errors.Add($"{f.Label} ({f.Id}): 'related' names unknown finding '{r}'.");
            f.Related = f.Related.Where(allById.ContainsKey).Select(r => allById[r].Label).Distinct().ToList();
        }
        return errors;
    }

    sealed record RollupResult(Dictionary<string, string> Ratings, Dictionary<string, double> Densities, string Overall, double OverallDensity, int TypesAnalyzed, JsonObject Points, JsonObject Bands);

    static class Rollup
    {
        public static RollupResult Compute(JsonObject metrics, List<ReportFinding> kept)
        {
            var scoring = metrics["scoring"] as JsonObject ?? [];
            var points = scoring["severity_points"] as JsonObject ?? [];
            var bands = scoring["rating_bands"] as JsonObject ?? [];
            var weights = scoring["principle_weights"] as JsonObject ?? [];
            int typesAnalyzed = Math.Max(1, (int)(Json.Num(metrics["stats"]?["types_analyzed"]) ?? 1));

            string Band(double density)
            {
                foreach (var level in new[] { "critical", "high", "medium" })
                    if (Json.Num(bands[level]) is { } t && density >= t) return level;
                return "low";
            }
            static string AtLeast(string rating, string floor) => Sev.Rank(rating) >= Sev.Rank(floor) ? rating : floor;

            var ratings = new Dictionary<string, string>();
            var densities = new Dictionary<string, double>();
            foreach (var p in Principle.All)
            {
                var fs = kept.Where(f => f.Principle == p).ToList();
                double density = fs.Sum(f => Json.Num(points[f.Severity]) ?? 0) / typesAnalyzed * 10;
                var rating = Band(density);
                if (fs.Any(f => f.Severity == "critical")) rating = AtLeast(rating, "high");
                ratings[p] = rating;
                densities[p] = density;
            }

            double totalWeight = Principle.All.Sum(p => Json.Num(weights[p]) ?? 1);
            double overallDensity = totalWeight == 0 ? 0 : Principle.All.Sum(p => densities[p] * (Json.Num(weights[p]) ?? 1)) / totalWeight;
            var overall = Band(overallDensity);
            if (ratings.Values.Contains("critical")) overall = AtLeast(overall, "high");
            else if (ratings.Values.Contains("high")) overall = AtLeast(overall, "medium");

            return new RollupResult(ratings, densities, overall, overallDensity, typesAnalyzed, points, bands);
        }
    }

    static string Md(string? s) => (s ?? "").Replace("|", "\\|").Replace("\r", " ").Replace("\n", " ");
    static string Loc(ReportFinding f) => f.Line > 0 ? $"`{f.File}:{f.Line}`" : $"`{f.File}`";
    static string ShortType(string t) => t.Contains('<') ? t[..t.IndexOf('<')].Split('.')[^1] + t[t.IndexOf('<')..] : t.Split('.')[^1];

    static string Render(JsonObject metrics, List<ReportFinding> all, ReviewData review, RollupResult r)
    {
        var kept = all.Where(f => !f.Dismissed).ToList();
        var stats = metrics["stats"] as JsonObject ?? [];
        var app = review.Application ?? Json.Str(metrics["application"]) ?? "Application";
        var sb = new StringBuilder();
        void L(string s = "") => sb.AppendLine(s);
        string Count(IEnumerable<ReportFinding> fs, string sev) => fs.Count(f => f.Severity == sev).ToString();

        L($"# SOLID Risk Profile: {app}");
        L();
        L("| | |");
        L("|---|---|");
        L($"| **Overall risk** | **{r.Overall.ToUpperInvariant()}** |");
        L($"| Repository | `{Json.Str(metrics["repo_path"])}` |");
        L($"| Generated | {Json.Str(metrics["generated_utc"])} |");
        L($"| Files analyzed | {Json.Num(stats["files_analyzed"])} ({Json.Num(stats["files_excluded"])} excluded) |");
        L($"| Types analyzed | {r.TypesAnalyzed} |");
        L($"| Findings | {kept.Count} kept ({Count(kept, "critical")} critical, {Count(kept, "high")} high, {Count(kept, "medium")} medium, {Count(kept, "low")} low), {all.Count(f => f.Dismissed)} dismissed as false positives |");
        L($"| Thresholds | {Md(Json.Str(metrics["config_source"]))} |");
        if (stats["files_with_parse_errors"] is JsonArray pe && pe.Count > 0)
            L($"| Parse warnings | {pe.Count} file(s) had syntax errors; their metrics may be incomplete |");
        L();

        L("## Executive summary");
        L();
        L(review.ExecutiveSummary ?? "_No review was applied; ratings are based on unreviewed metric findings._");
        L();

        L("## Risk by principle");
        L();
        L("| Principle | Risk | Critical | High | Medium | Low | Weighted density |");
        L("|---|---|---:|---:|---:|---:|---:|");
        foreach (var p in Principle.All)
        {
            var fs = kept.Where(f => f.Principle == p).ToList();
            L($"| {Principle.Name(p)} ({p.ToUpperInvariant()}) | **{r.Ratings[p].ToUpperInvariant()}** | {Count(fs, "critical")} | {Count(fs, "high")} | {Count(fs, "medium")} | {Count(fs, "low")} | {r.Densities[p]:0.0} |");
        }
        L();
        var pointText = string.Join(", ", Sev.Ascending.Select(s => $"{s} = {Fmt.Num(Json.Num(r.Points[s]) ?? 0)}"));
        var bandText = string.Join(", ", new[] { "medium", "high", "critical" }.Where(b => Json.Num(r.Bands[b]) is not null).Select(b => $"{Sev.Title(b)} >= {Fmt.Num(Json.Num(r.Bands[b])!.Value)}"));
        L($"_Weighted density = severity points per 10 types analyzed ({pointText}). Bands: {bandText}; below that is Low. " +
          "A principle with any Critical finding is rated at least High. Overall risk is the weighted average density, raised to at least High if any principle is Critical, or at least Medium if any principle is High._");
        L();

        var hotspots = kept.GroupBy(f => f.Type)
            .Select(g => (Type: g.Key, File: g.First().File, Count: g.Count(), Principles: g.Select(f => f.Principle.ToUpperInvariant()).Distinct().ToList(),
                Points: g.Sum(f => Json.Num(r.Points[f.Severity]) ?? 0), Worst: g.Max(f => Sev.Rank(f.Severity))))
            .OrderByDescending(h => h.Points).ThenByDescending(h => h.Worst).Take(10).ToList();
        if (hotspots.Count > 0)
        {
            L("## Hotspots");
            L();
            L("Types that concentrate the most risk across principles.");
            L();
            L("| Type | File | Findings | Principles | Worst | Points |");
            L("|---|---|---:|---|---|---:|");
            foreach (var h in hotspots)
                L($"| `{Md(ShortType(h.Type))}` | `{Md(h.File)}` | {h.Count} | {string.Join(", ", h.Principles)} | {Sev.Title(Sev.Ascending[h.Worst])} | {Fmt.Num(h.Points)} |");
            L();
        }

        if (review.Recommendations.Count > 0)
        {
            L("## Recommendations");
            L();
            for (int i = 0; i < review.Recommendations.Count; i++) L($"{i + 1}. {review.Recommendations[i]}");
            L();
        }

        L("## Findings");
        L();
        foreach (var p in Principle.All)
        {
            var fs = kept.Where(f => f.Principle == p).OrderByDescending(f => Sev.Rank(f.Severity)).ThenBy(f => f.Label).ToList();
            L($"### {Principle.Name(p)} ({p.ToUpperInvariant()}): {r.Ratings[p].ToUpperInvariant()}");
            L();
            if (fs.Count == 0) { L("No findings."); L(); continue; }

            foreach (var f in fs.Where(f => Sev.Rank(f.Severity) >= Sev.Rank("high")))
            {
                L($"#### {f.Label} · {Sev.Title(f.Severity)} · `{Md(ShortType(f.Type))}`");
                L();
                L($"- **Id:** `{f.Id}`");
                L($"- **Location:** {Loc(f)}");
                L(f.FromReview
                    ? $"- **Issue:** {f.Criterion} (found during manual review)"
                    : $"- **Criterion:** `{f.Criterion}` = {Fmt.Num(f.Value ?? 0)} ({f.OriginalSeverity} threshold >= {Fmt.Num(f.Threshold ?? 0)})");
                L($"- **Evidence:** {f.Details}");
                if (f.Severity != f.OriginalSeverity) L($"- **Severity adjusted** from {Sev.Title(f.OriginalSeverity)} to {Sev.Title(f.Severity)}: {f.Reason}");
                else if (!string.IsNullOrWhiteSpace(f.Reason)) L($"- **Reviewer note:** {f.Reason}");
                if (f.Evidence.Count > 0) L($"- **Reviewer evidence:** {string.Join("; ", f.Evidence)}");
                if (f.Related.Count > 0) L($"- **Related:** {string.Join(", ", f.Related)} (same root cause; counted once)");
                if (!string.IsNullOrWhiteSpace(f.Recommendation)) L($"- **Recommendation:** {f.Recommendation}");
                L();
            }

            var minor = fs.Where(f => Sev.Rank(f.Severity) < Sev.Rank("high")).ToList();
            if (minor.Count > 0)
            {
                L("| Finding | Id | Severity | Type | Location | Criterion | Value | Notes |");
                L("|---|---|---|---|---|---|---:|---|");
                foreach (var f in minor)
                {
                    var notes = string.Join(" ", new[] { f.FromReview ? f.Details : null, f.Severity != f.OriginalSeverity ? $"Adjusted from {f.OriginalSeverity}: {f.Reason}" : f.Reason, f.Recommendation,
                            f.Related.Count > 0 ? $"Related: {string.Join(", ", f.Related)}." : null }
                        .Where(s => !string.IsNullOrWhiteSpace(s)));
                    if (notes.Length == 0) notes = f.Details;
                    L($"| {f.Label} | `{f.Id}` | {Sev.Title(f.Severity)} | `{Md(ShortType(f.Type))}` | {Loc(f)} | {Md(f.Criterion)} | {(f.Value is { } v ? Fmt.Num(v) : "")} | {Md(notes)} |");
                }
                L();
            }
        }

        var dismissed = all.Where(f => f.Dismissed).ToList();
        if (dismissed.Count > 0)
        {
            L("## Dismissed findings");
            L();
            L("Metric findings that manual review judged to be false positives. They do not count toward the ratings.");
            L();
            L("| Finding | Id | Type | Criterion | Value | Reason |");
            L("|---|---|---|---|---:|---|");
            foreach (var f in dismissed)
                L($"| {f.Label} | `{f.Id}` | `{Md(ShortType(f.Type))}` | {f.Criterion} | {Fmt.Num(f.Value ?? 0)} | {Md(f.Reason)} |");
            L();
        }

        L("## Appendix: thresholds used");
        L();
        L("A type gets a finding at the highest band its value reaches (value >= threshold).");
        L();
        L("| Principle | Criterion | Low | Medium | High | Critical |");
        L("|---|---|---:|---:|---:|---:|");
        foreach (var t in metrics["thresholds"] as JsonArray ?? [])
        {
            string Cell(string k) => Json.Num(t![k]) is { } v ? Fmt.Num(v) : "-";
            var enabled = Json.Bool(t!["enabled"], true);
            L($"| {Json.Str(t["principle"])!.ToUpperInvariant()} | `{Json.Str(t["criterion"])}`{(enabled ? "" : " (disabled)")} | {Cell("low")} | {Cell("medium")} | {Cell("high")} | {Cell("critical")} |");
        }
        return sb.ToString();
    }
}
