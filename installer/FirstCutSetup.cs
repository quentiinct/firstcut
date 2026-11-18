// FirstCut - installateur Windows.
//
// Un seul .exe : le panneau est embarque (ressource payload.zip). Installe pour
// l'utilisateur courant, sans droits administrateur :
//   - %APPDATA%\Adobe\CEP\extensions\com.firstcut.ppro  (le panneau)
//   - HKCU\Software\Adobe\CSXS.9 a 14, PlayerDebugMode=1 (Premiere charge les
//     panneaux non signes)
//   - %LOCALAPPDATA%\Programs\FirstCut\FirstCut-Setup.exe + entree dans
//     Parametres > Applications (desinstallation)
// Ne touche a aucune autre extension.
//
//   FirstCut-Setup.exe                     fenetre d'installation
//   FirstCut-Setup.exe /quiet              installe sans fenetre (code 0 = ok)
//   FirstCut-Setup.exe /uninstall          fenetre de desinstallation
//   FirstCut-Setup.exe /uninstall /quiet   desinstalle sans fenetre (/purge : reglages aussi)
//
// Compile par build.ps1 avec le csc.exe de .NET Framework 4 (C# 5).

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Theme
{
    public static readonly Color Bg = Color.FromArgb(20, 22, 28);
    public static readonly Color Line = Color.FromArgb(44, 50, 64);
    public static readonly Color Line2 = Color.FromArgb(70, 78, 98);
    public static readonly Color Track = Color.FromArgb(38, 43, 56);
    public static readonly Color Text = Color.FromArgb(234, 237, 244);
    public static readonly Color Soft = Color.FromArgb(196, 202, 218);
    public static readonly Color Muted = Color.FromArgb(140, 149, 170);
    public static readonly Color Warn = Color.FromArgb(255, 199, 102);
    public static readonly Color Good = Color.FromArgb(61, 220, 151);
    public static readonly Color Bad = Color.FromArgb(255, 128, 128);
    public static readonly Color Orange = FirstCutLogo.Orange;
    public static readonly Color OrangeLight = FirstCutLogo.OrangeLight;
    public static readonly Color OrangeHover = Color.FromArgb(250, 128, 68);
    public static readonly Color OrangeDown = FirstCutLogo.OrangeDark;
}

// ============================================================================
// Installation proprement dite (sans interface)
// ============================================================================

static class Installer
{
    public const string ExtId = "com.firstcut.ppro";
    static readonly string[] OldIds = { "com.autoderush.ppro" };
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\FirstCut";
    static readonly int[] CsxsVersions = { 9, 10, 11, 12, 13, 14 };

    public delegate void Progress(int percent, string text);

    static string Roaming { get { return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); } }
    static string Local { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }
    public static string ExtensionsDir { get { return Path.Combine(Roaming, @"Adobe\CEP\extensions"); } }
    public static string Target { get { return Path.Combine(ExtensionsDir, ExtId); } }
    public static string AppDir { get { return Path.Combine(Local, @"Programs\FirstCut"); } }
    public static string DataDir { get { return Path.Combine(Roaming, "FirstCut"); } }
    public static string LogFile { get { return Path.Combine(Path.GetTempPath(), "FirstCut-setup.log"); } }

    public static void Log(string msg)
    {
        try
        {
            File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine);
        }
        catch { }
    }

    /// <summary>Version du panneau deja installe (ou de l'ancien nom), sinon null.</summary>
    public static string InstalledVersion()
    {
        string v = ManifestVersion(Target);
        if (v != null) return v;
        foreach (string id in OldIds)
        {
            v = ManifestVersion(Path.Combine(ExtensionsDir, id));
            if (v != null) return v;
        }
        return null;
    }

    static string ManifestVersion(string dir)
    {
        try
        {
            string m = File.ReadAllText(Path.Combine(dir, @"CSXS\manifest.xml"));
            Match x = Regex.Match(m, "ExtensionBundleVersion=\"([0-9.]+)\"");
            return x.Success ? x.Groups[1].Value : null;
        }
        catch
        {
            return null;
        }
    }

    public static bool IsRegistered()
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(UninstallKey))
        {
            return k != null;
        }
    }

    public static bool PremiereRunning()
    {
        foreach (Process p in Process.GetProcesses())
        {
            try
            {
                if (p.ProcessName.StartsWith("Adobe Premiere Pro", StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch { }
        }
        return false;
    }

    public static void Install(Progress report)
    {
        Log("Installation de FirstCut " + BuildInfo.Version);
        report(3, "Préparation…");
        CleanOldUninstallers();
        string stage = Path.Combine(Path.GetTempPath(), "FirstCut-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        try
        {
            Extract(stage, report);
            if (!File.Exists(Path.Combine(stage, @"CSXS\manifest.xml")))
                throw new Exception("Le paquet d'installation est incomplet.");

            report(74, "Retrait de l'ancienne version…");
            Directory.CreateDirectory(ExtensionsDir);
            foreach (string id in OldIds) DeleteDir(Path.Combine(ExtensionsDir, id));
            DeleteDir(Target);

            report(82, "Copie du panneau…");
            MoveDir(stage, Target);

            report(90, "Autorisation du panneau dans Premiere…");
            EnableUnsignedPanels();

            report(95, "Ajout dans Paramètres › Applications…");
            Register();

            report(100, "Terminé.");
            Log("OK : " + Target);
        }
        finally
        {
            if (Directory.Exists(stage))
            {
                try { Directory.Delete(stage, true); }
                catch { }
            }
        }
    }

    public static void Uninstall(bool removeSettings, Progress report)
    {
        Log("Desinstallation (reglages " + (removeSettings ? "retires" : "gardes") + ")");
        report(10, "Retrait du panneau…");
        DeleteDir(Target);
        foreach (string id in OldIds) DeleteDir(Path.Combine(ExtensionsDir, id));
        if (removeSettings)
        {
            report(45, "Retrait des réglages…");
            DeleteQuietly(DataDir);
        }
        DeleteQuietly(Path.Combine(Path.GetTempPath(), "FirstCut"));

        report(75, "Retrait de Paramètres › Applications…");
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); }
        catch { }
        ReleaseParent(true);
        RemoveAppDir();
        CleanOldUninstallers();
        report(100, "Terminé.");
        Log("Desinstallation OK");
    }

    // ------------------------------------------------- desinstallation en deux temps
    //
    // Lance depuis %LOCALAPPDATA%\Programs\FirstCut (Parametres > Applications),
    // ce programme ne peut pas effacer son propre fichier. Comme les
    // installateurs classiques, il se recopie dans %TEMP% et passe la main a
    // cette copie, qui desinstalle puis retire le dossier une fois l'original
    // ferme. En mode silencieux, l'original attend le resultat pour rendre le
    // bon code de sortie.

    static int parentPid;
    static string handoffToken;

    static string SelfPath { get { return Path.GetFullPath(Assembly.GetExecutingAssembly().Location); } }

    public static bool RunningFromAppDir()
    {
        return SelfPath.StartsWith(Path.GetFullPath(AppDir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    static string EventName(string token, string what)
    {
        return @"Local\FirstCut-uninstall-" + token + "-" + what;
    }

    /// <summary>Recopie ce programme dans %TEMP% et lui confie la desinstallation.</summary>
    public static int HandOff(bool quiet, bool purge)
    {
        string token = Guid.NewGuid().ToString("N").Substring(0, 12);
        string copy = Path.Combine(Path.GetTempPath(), "FirstCut-Uninstall-" + token + ".exe");
        File.Copy(SelfPath, copy, true);
        using (EventWaitHandle ok = new EventWaitHandle(false, EventResetMode.ManualReset, EventName(token, "ok")))
        using (EventWaitHandle fail = new EventWaitHandle(false, EventResetMode.ManualReset, EventName(token, "fail")))
        {
            string args = "/uninstall" + (quiet ? " /quiet" : "") + (purge ? " /purge" : "") +
                " /handoff " + Process.GetCurrentProcess().Id + ":" + token;
            ProcessStartInfo psi = new ProcessStartInfo(copy, args);
            psi.UseShellExecute = false;
            psi.WorkingDirectory = Path.GetTempPath();
            Log("Desinstallation confiee a " + copy);
            using (Process child = Process.Start(psi))
            {
                if (!quiet) return 0;
                WaitHandle[] both = { ok, fail };
                while (true)
                {
                    int hit = WaitHandle.WaitAny(both, 500);
                    if (hit == 0) return 0;
                    if (hit == 1) return 1;
                    if (child.HasExited) return child.ExitCode == 0 && ok.WaitOne(0) ? 0 : 1;
                }
            }
        }
    }

    /// <summary>Copie temporaire : note qui attendre (argument /handoff pid:jeton).</summary>
    public static void TakeOver(string arg)
    {
        int colon = arg.IndexOf(':');
        if (colon <= 0) return;
        int.TryParse(arg.Substring(0, colon), out parentPid);
        handoffToken = arg.Substring(colon + 1);
    }

    /// <summary>Donne le resultat a l'original (mode silencieux), qui peut alors se fermer.</summary>
    public static void ReleaseParent(bool success)
    {
        if (handoffToken == null) return;
        try
        {
            using (EventWaitHandle h = EventWaitHandle.OpenExisting(EventName(handoffToken, success ? "ok" : "fail")))
            {
                h.Set();
            }
        }
        catch { }
    }

    /// <summary>Retire le dossier du programme, une fois l'original ferme.</summary>
    static void RemoveAppDir()
    {
        if (!Directory.Exists(AppDir)) return;
        if (RunningFromAppDir())
        {
            Log("Dossier garde, programme en cours : " + AppDir);
            return;
        }
        if (parentPid > 0)
        {
            try
            {
                using (Process p = Process.GetProcessById(parentPid)) p.WaitForExit(30000);
            }
            catch { }
        }
        for (int i = 0; i < 10; i++)
        {
            try
            {
                Directory.Delete(AppDir, true);
                return;
            }
            catch
            {
                Thread.Sleep(300);
            }
        }
        Log("Non supprime : " + AppDir);
    }

    /// <summary>Efface les copies temporaires laissees par les desinstallations precedentes.</summary>
    public static void CleanOldUninstallers()
    {
        try
        {
            foreach (string f in Directory.GetFiles(Path.GetTempPath(), "FirstCut-Uninstall-*.exe"))
            {
                if (string.Equals(Path.GetFullPath(f), SelfPath, StringComparison.OrdinalIgnoreCase)) continue;
                try { File.Delete(f); }
                catch { }
            }
        }
        catch { }
    }

    // ------------------------------------------------------------------ etapes

    static void Extract(string stage, Progress report)
    {
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        {
            if (s == null) throw new Exception("Le panneau n'est pas embarqué dans ce programme.");
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                string root = Path.GetFullPath(stage).TrimEnd('\\') + "\\";
                int n = zip.Entries.Count;
                int i = 0;
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    i++;
                    string name = e.FullName.Replace('/', '\\');
                    string dest = Path.GetFullPath(Path.Combine(stage, name));
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new Exception("Chemin invalide dans le paquet : " + e.FullName);
                    if (name.EndsWith("\\"))
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    e.ExtractToFile(dest, true);
                    if (i % 20 == 0 || i == n) report(5 + 68 * i / n, "Décompression… " + i + " / " + n + " fichiers");
                }
            }
        }
    }

    /// <summary>Supprime un dossier du panneau ; s'il est bloque, dit quoi faire.</summary>
    static void DeleteDir(string dir)
    {
        if (!Directory.Exists(dir)) return;
        Exception last = null;
        for (int i = 0; i < 5; i++)
        {
            try
            {
                foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                {
                    try { File.SetAttributes(f, FileAttributes.Normal); }
                    catch { }
                }
                Directory.Delete(dir, true);
                return;
            }
            catch (Exception e)
            {
                last = e;
                Thread.Sleep(400);
            }
        }
        throw new Exception("Un fichier du panneau est utilisé par un autre programme. Ferme Premiere Pro puis réessaie.\n(" + last.Message + ")");
    }

    static void DeleteQuietly(string dir)
    {
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
        catch (Exception e)
        {
            Log("Non supprime : " + dir + " (" + e.Message + ")");
        }
    }

    static void MoveDir(string from, string to)
    {
        try
        {
            Directory.Move(from, to);
        }
        catch (IOException)
        {
            CopyDir(from, to);
        }
    }

    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (string f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
        foreach (string d in Directory.GetDirectories(from)) CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
    }

    static void EnableUnsignedPanels()
    {
        foreach (int v in CsxsVersions)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Adobe\CSXS." + v))
            {
                if (k != null) k.SetValue("PlayerDebugMode", "1", RegistryValueKind.String);
            }
        }
    }

    static long DirSize(string dir)
    {
        long total = 0;
        try
        {
            foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) total += new FileInfo(f).Length;
        }
        catch { }
        return total;
    }

    /// <summary>Garde une copie de ce programme pour la desinstallation, et l'inscrit dans Windows.</summary>
    static void Register()
    {
        Directory.CreateDirectory(AppDir);
        string self = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
        string copy = Path.Combine(AppDir, "FirstCut-Setup.exe");
        if (!string.Equals(self, Path.GetFullPath(copy), StringComparison.OrdinalIgnoreCase)) File.Copy(self, copy, true);

        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", "FirstCut pour Premiere Pro");
            k.SetValue("DisplayVersion", BuildInfo.Version);
            k.SetValue("Publisher", "@quentiinct");
            k.SetValue("URLInfoAbout", "https://github.com/quentiinct/firstcut");
            k.SetValue("DisplayIcon", copy + ",0");
            k.SetValue("InstallLocation", Target);
            k.SetValue("UninstallString", "\"" + copy + "\" /uninstall");
            k.SetValue("QuietUninstallString", "\"" + copy + "\" /uninstall /quiet");
            k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("EstimatedSize", (int)(DirSize(Target) / 1024), RegistryValueKind.DWord);
        }
    }

}

// ============================================================================
// Interface
// ============================================================================

/// <summary>Bouton arrondi, plein (orange) ou contour.</summary>
class PillButton : Control, IButtonControl
{
    public bool Primary = true;
    bool hover;
    bool down;
    DialogResult result;

    public PillButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.StandardClick, true);
        Cursor = Cursors.Hand;
        Font = new Font("Segoe UI Semibold", 10f);
        TabStop = true;
    }

    public DialogResult DialogResult { get { return result; } set { result = value; } }
    public void NotifyDefault(bool value) { }
    public void PerformClick()
    {
        if (Enabled && Visible) OnClick(EventArgs.Empty);
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    protected override bool IsInputKey(Keys k) { return k == Keys.Space || base.IsInputKey(k); }
    protected override void OnKeyUp(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Space) PerformClick();
        base.OnKeyUp(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(Parent != null ? Parent.BackColor : Theme.Bg);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        float f = g.DpiX / 96f;
        RectangleF r = new RectangleF(1f, 1f, Width - 2.5f, Height - 2.5f);
        Color fill;
        Color border;
        Color fg;
        if (Primary)
        {
            fill = !Enabled ? Color.FromArgb(84, 56, 46) : down ? Theme.OrangeDown : hover ? Theme.OrangeHover : Theme.Orange;
            border = fill;
            fg = Enabled ? Color.White : Color.FromArgb(176, 160, 150);
        }
        else
        {
            fill = Enabled && hover ? Theme.Track : Theme.Bg;
            border = Theme.Line2;
            fg = Enabled ? Theme.Text : Theme.Muted;
        }
        bool ring = Focused && ShowFocusCues;
        using (GraphicsPath p = FirstCutLogo.RoundRect(r, 9f * f))
        using (SolidBrush b = new SolidBrush(fill))
        using (Pen pen = new Pen(ring ? Theme.OrangeLight : border, ring ? 2f * f : 1f))
        {
            g.FillPath(b, p);
            g.DrawPath(pen, p);
        }
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, fg, fill,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
}

/// <summary>Barre de progression fine, orange.</summary>
class Bar : Control
{
    int value;

    public Bar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw, true);
    }

    public int Value
    {
        get { return value; }
        set { this.value = Math.Max(0, Math.Min(100, value)); Invalidate(); }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(Theme.Bg);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        float h = Height - 1f;
        using (GraphicsPath p = FirstCutLogo.RoundRect(new RectangleF(0, 0, Width - 1f, h), h / 2f))
        using (SolidBrush b = new SolidBrush(Theme.Track))
        {
            g.FillPath(b, p);
        }
        if (value <= 0) return;
        float w = Math.Max(h, (Width - 1f) * value / 100f);
        using (GraphicsPath p = FirstCutLogo.RoundRect(new RectangleF(0, 0, w, h), h / 2f))
        using (LinearGradientBrush lb = new LinearGradientBrush(new PointF(-1, 0), new PointF(Width + 1, 0), Theme.OrangeLight, Theme.Orange))
        {
            g.FillPath(lb, p);
        }
    }
}

/// <summary>En-tete : logo, nom, sous-titre.</summary>
class Header : Control
{
    public string Sub = "";

    public Header()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw, true);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        float f = g.DpiX / 96f;
        g.Clear(Theme.Bg);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        // lueur orange derriere le logo
        using (GraphicsPath gp = new GraphicsPath())
        {
            gp.AddEllipse(-70f * f, -110f * f, 300f * f, 260f * f);
            using (PathGradientBrush pb = new PathGradientBrush(gp))
            {
                pb.CenterColor = Color.FromArgb(70, 242, 106, 46);
                pb.SurroundColors = new Color[] { Color.FromArgb(0, 242, 106, 46) };
                g.FillPath(pb, gp);
            }
        }
        FirstCutLogo.Draw(g, new RectangleF(32f * f, 24f * f, 56f * f, 56f * f));

        TextFormatFlags fl = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
        using (Font big = new Font("Segoe UI Semibold", 20f))
        using (Font small = new Font("Segoe UI", 9.5f))
        {
            Point at = new Point((int)(104f * f), (int)(22f * f));
            Size first = TextRenderer.MeasureText(g, "First", big, Size.Empty, fl);
            TextRenderer.DrawText(g, "First", big, at, Theme.Text, fl);
            TextRenderer.DrawText(g, "Cut", big, new Point(at.X + first.Width, at.Y), Theme.OrangeLight, fl);
            TextRenderer.DrawText(g, Sub, small, new Point(at.X + (int)(2f * f), at.Y + first.Height + (int)(4f * f)), Theme.Muted, fl);
        }
        using (LinearGradientBrush line = new LinearGradientBrush(new PointF(0, 0), new PointF(Width, 0),
            Color.FromArgb(150, 242, 106, 46), Color.FromArgb(0, 242, 106, 46)))
        {
            g.FillRectangle(line, 0, Height - 1, Width, 1);
        }
    }
}

enum Mode { Install, Uninstall }

class SetupForm : Form
{
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    Mode mode;
    bool busy;
    bool finished;
    readonly bool premiereOpen;

    readonly Header header = new Header();
    readonly Label title = new Label();
    readonly Label body = new Label();
    readonly Label warn = new Label();
    readonly CheckBox purge = new CheckBox();
    readonly Bar bar = new Bar();
    readonly Label status = new Label();
    readonly LinkLabel link = new LinkLabel();
    readonly PillButton primary = new PillButton();
    readonly PillButton secondary = new PillButton();

    public SetupForm(Mode startMode)
    {
        mode = startMode;
        premiereOpen = Installer.PremiereRunning();

        SuspendLayout();
        // Mise a l'echelle faite ici : l'automatique de WinForms agrandit deux
        // fois la largeur des Label en 150 %. Les polices en points suivent seules.
        AutoScaleMode = AutoScaleMode.None;
        Font = new Font("Segoe UI", 9.75f);
        BackColor = Theme.Bg;
        ForeColor = Theme.Text;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(520, 418);
        Text = "FirstCut";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { }

        header.Sub = "pour Adobe Premiere Pro   ·   v" + BuildInfo.Version + "   ·   par @quentiinct";
        header.SetBounds(0, 0, 520, 104);

        foreach (Label l in new Label[] { title, body, warn, status })
        {
            l.AutoSize = false;
            l.UseMnemonic = false;
        }
        title.SetBounds(32, 122, 456, 30);
        title.Font = new Font("Segoe UI Semibold", 13.5f);
        title.ForeColor = Theme.Text;

        body.SetBounds(32, 158, 456, 112);
        body.ForeColor = Theme.Soft;

        purge.SetBounds(32, 230, 456, 26);
        purge.Text = "Supprimer aussi mes réglages et mes clés (Pexels, Claude)";
        purge.ForeColor = Theme.Soft;
        purge.Visible = false;

        warn.SetBounds(32, 278, 456, 44);
        warn.ForeColor = Theme.Warn;
        warn.Visible = false;

        bar.SetBounds(32, 326, 456, 6);
        bar.Visible = false;
        status.SetBounds(32, 336, 456, 20);
        status.ForeColor = Theme.Muted;
        status.Font = new Font("Segoe UI", 9f);

        link.SetBounds(32, 372, 160, 22);
        link.LinkColor = Theme.Muted;
        link.ActiveLinkColor = Theme.OrangeLight;
        link.VisitedLinkColor = Theme.Muted;
        link.LinkBehavior = LinkBehavior.HoverUnderline;
        link.TextAlign = ContentAlignment.MiddleLeft;
        link.Text = "Désinstaller";
        link.LinkClicked += delegate
        {
            if (busy) return;
            mode = Mode.Uninstall;
            ShowStart();
        };

        primary.SetBounds(348, 364, 140, 38);
        primary.Click += delegate { OnPrimary(); };
        secondary.Primary = false;
        secondary.SetBounds(228, 364, 110, 38);
        secondary.Text = "Annuler";
        secondary.Click += delegate
        {
            if (!busy) Close();
        };

        Controls.AddRange(new Control[] { header, title, body, purge, warn, bar, status, link, secondary, primary });
        float scale = 1f;
        using (Graphics sg = Graphics.FromHwnd(IntPtr.Zero)) scale = sg.DpiX / 96f;
        if (scale > 1.01f)
        {
            foreach (Control c in Controls)
                c.SetBounds(Px(c.Left, scale), Px(c.Top, scale), Px(c.Width, scale), Px(c.Height, scale));
            ClientSize = new Size(Px(520, scale), Px(418, scale));
        }
        AcceptButton = primary;
        CancelButton = secondary;
        ResumeLayout(false);
        PerformLayout();
        ShowStart();
    }

    static int Px(int v, float scale)
    {
        return (int)Math.Round(v * scale);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            int on = 1;
            if (DwmSetWindowAttribute(Handle, 20, ref on, 4) != 0) DwmSetWindowAttribute(Handle, 19, ref on, 4);
            int caption = Theme.Bg.R | (Theme.Bg.G << 8) | (Theme.Bg.B << 16);
            DwmSetWindowAttribute(Handle, 35, ref caption, 4);
        }
        catch { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (busy) e.Cancel = true;
        base.OnFormClosing(e);
    }

    // ----------------------------------------------------------------- ecrans

    void ShowStart()
    {
        finished = false;
        bar.Visible = false;
        bar.Value = 0;
        status.Text = "";
        title.ForeColor = Theme.Text;
        secondary.Visible = true;
        secondary.Text = "Annuler";
        primary.Enabled = true;
        secondary.Enabled = true;
        string installed = Installer.InstalledVersion();

        if (mode == Mode.Uninstall)
        {
            Text = "Désinstaller FirstCut";
            title.Text = "Désinstaller FirstCut";
            body.Text = "Retire le panneau FirstCut de Premiere Pro.\n\nTes projets et tes séquences ne sont pas touchés.";
            purge.Visible = true;
            primary.Text = "Désinstaller";
            link.Visible = false;
            warn.Visible = premiereOpen;
            warn.Text = "Premiere Pro est ouvert : le panneau disparaîtra au prochain démarrage.";
            return;
        }

        Text = "Installation de FirstCut";
        purge.Visible = false;
        string intro = "Le dérush automatique pour Premiere Pro.\nSilences, caméras, zooms et B-rolls, en un clic.";
        if (installed == null)
        {
            title.Text = "Installer FirstCut";
            primary.Text = "Installer";
        }
        else if (installed == BuildInfo.Version)
        {
            title.Text = "Réinstaller FirstCut";
            intro = "La version " + installed + " est déjà installée. La réinstaller remet le panneau d'origine ; tes réglages sont gardés.";
            primary.Text = "Réinstaller";
        }
        else
        {
            title.Text = "Mettre à jour FirstCut";
            intro = "Version installée : " + installed + "   →   nouvelle version : " + BuildInfo.Version + ".\nTes réglages et tes clés sont gardés.";
            primary.Text = "Mettre à jour";
        }
        body.Text = intro + "\n\n•  Pour ton compte Windows, sans droits administrateur\n•  Ne modifie aucune autre extension\n•  Se désinstalle depuis Paramètres › Applications";
        link.Visible = installed != null || Installer.IsRegistered();
        warn.Visible = premiereOpen;
        warn.Text = "Premiere Pro est ouvert : tu peux installer maintenant, il faudra juste le redémarrer ensuite.";
    }

    void ShowBusy(string what)
    {
        busy = true;
        primary.Enabled = false;
        secondary.Enabled = false;
        link.Visible = false;
        purge.Enabled = false;
        bar.Visible = true;
        bar.Value = 2;
        status.Text = what;
    }

    void ShowDone()
    {
        busy = false;
        finished = true;
        purge.Visible = false;
        purge.Enabled = true;
        link.Visible = false;
        secondary.Visible = false;
        primary.Enabled = true;
        primary.Text = "Terminer";
        status.Text = "";
        bar.Value = 100;
        title.ForeColor = Theme.Good;
        if (mode == Mode.Uninstall)
        {
            title.Text = "FirstCut est désinstallé";
            body.Text = "Le panneau a été retiré de Premiere Pro.\n\nMerci de l'avoir essayé !";
            warn.Visible = false;
            return;
        }
        title.Text = "C'est installé !";
        body.Text = (premiereOpen ? "1.  Ferme Premiere Pro, puis rouvre-le.\n" : "1.  Ouvre Premiere Pro.\n") +
                    "2.  Menu  Fenêtre › Extensions › FirstCut.\n\nUne présentation rapide t'attend au premier lancement.";
        warn.Visible = false;
    }

    void ShowError(Exception err)
    {
        busy = false;
        purge.Enabled = true;
        primary.Enabled = true;
        secondary.Enabled = true;
        secondary.Text = "Fermer";
        primary.Text = "Réessayer";
        title.ForeColor = Theme.Bad;
        title.Text = mode == Mode.Uninstall ? "La désinstallation n'a pas abouti" : "L'installation n'a pas abouti";
        body.Text = err.Message + "\n\nDétails : " + Installer.LogFile;
        status.Text = "";
        bar.Visible = false;
    }

    // ---------------------------------------------------------------- actions

    void OnPrimary()
    {
        if (busy) return;
        if (finished)
        {
            Close();
            return;
        }
        bool uninstalling = mode == Mode.Uninstall;
        bool removeSettings = purge.Checked;
        ShowBusy(uninstalling ? "Désinstallation…" : "Installation…");
        Thread t = new Thread(delegate ()
        {
            Exception error = null;
            DateTime start = DateTime.Now;
            try
            {
                Installer.Progress report = delegate (int p, string s)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        bar.Value = p;
                        status.Text = s;
                    });
                };
                if (uninstalling) Installer.Uninstall(removeSettings, report);
                else Installer.Install(report);
                // laisser voir la barre se remplir
                int left = 700 - (int)(DateTime.Now - start).TotalMilliseconds;
                if (left > 0) Thread.Sleep(left);
            }
            catch (Exception e)
            {
                error = e;
                Installer.Log("ERREUR " + e);
            }
            BeginInvoke((MethodInvoker)delegate
            {
                if (error != null) ShowError(error);
                else ShowDone();
            });
        });
        t.IsBackground = true;
        t.Start();
    }

    // -------------------------------------------- apercu (fabrication / tests)

    /// <summary>Enregistre l'image d'un ecran, sans rien installer.</summary>
    public void SaveScreen(string png, string state)
    {
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-4000, -4000);
        ShowInTaskbar = false;
        if (state == "uninstall") { mode = Mode.Uninstall; ShowStart(); }
        else if (state == "busy") { ShowBusy("Décompression… 412 / 980 fichiers"); bar.Value = 46; busy = false; }
        else if (state == "done") ShowDone();
        else if (state == "error") ShowError(new Exception("Un fichier du panneau est utilisé par un autre programme. Ferme Premiere Pro puis réessaie."));
        else if (state == "warn") { warn.Visible = true; }
        Show();
        Application.DoEvents();
        using (Bitmap bmp = new Bitmap(ClientSize.Width, ClientSize.Height))
        {
            Point origin = PointToScreen(Point.Empty);
            int dx = origin.X - Location.X;
            int dy = origin.Y - Location.Y;
            using (Bitmap whole = new Bitmap(Width, Height))
            {
                DrawToBitmap(whole, new Rectangle(0, 0, Width, Height));
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.DrawImage(whole, new Rectangle(0, 0, bmp.Width, bmp.Height), new Rectangle(dx, dy, bmp.Width, bmp.Height), GraphicsUnit.Pixel);
                }
            }
            bmp.Save(png, System.Drawing.Imaging.ImageFormat.Png);
        }
        Close();
    }
}

static class Program
{
    static bool Has(string[] args, string flag)
    {
        foreach (string a in args)
        {
            if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    static string After(string[] args, string flag)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        }
        return null;
    }

    [STAThread]
    static int Main(string[] args)
    {
        bool uninstall = Has(args, "/uninstall");
        bool quiet = Has(args, "/quiet") || Has(args, "/silent");
        string handoff = After(args, "/handoff");
        if (handoff != null) Installer.TakeOver(handoff);
        else if (uninstall && Installer.RunningFromAppDir())
        {
            try
            {
                return Installer.HandOff(quiet, Has(args, "/purge"));
            }
            catch (Exception e)
            {
                Installer.Log("Passage de main impossible, desinstallation sur place : " + e.Message);
            }
        }
        if (quiet)
        {
            try
            {
                Installer.Progress none = delegate (int p, string s) { };
                if (uninstall) Installer.Uninstall(Has(args, "/purge"), none);
                else Installer.Install(none);
                return 0;
            }
            catch (Exception e)
            {
                Installer.Log("ERREUR " + e);
                Installer.ReleaseParent(false);
                return 1;
            }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        SetupForm form = new SetupForm(uninstall ? Mode.Uninstall : Mode.Install);
        string capture = After(args, "/capture");
        if (capture != null)
        {
            form.SaveScreen(capture, After(args, "/state") ?? "start");
            return 0;
        }
        Application.Run(form);
        return 0;
    }
}
