// Controls of the TryHackX Media Server wizard. C# 5 only (Windows PowerShell 5.1 / CodeDom).
//
// Everything here paints itself, so Control.DrawToBitmap captures exactly what a
// person sees: the -Preview mode renders every page to PNG without showing a window.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace TryHackX.Setup
{
    public static class Theme
    {
        /// <summary>Layout scale: 1.0 at 96 dpi. Set once, before any control is created.</summary>
        public static float Scale = 1f;

        public static Color Sidebar = Color.FromArgb(11, 18, 32);
        public static Color SidebarRaised = Color.FromArgb(22, 32, 54);
        public static Color SidebarText = Color.FromArgb(232, 238, 247);
        public static Color SidebarMuted = Color.FromArgb(132, 150, 184);
        public static Color Accent = Color.FromArgb(31, 127, 240);
        public static Color AccentHover = Color.FromArgb(58, 146, 245);
        public static Color AccentPressed = Color.FromArgb(22, 103, 199);
        public static Color AccentSoft = Color.FromArgb(235, 244, 255);
        public static Color Window = Color.White;
        public static Color Surface = Color.FromArgb(246, 248, 251);
        public static Color Text = Color.FromArgb(22, 32, 43);
        public static Color Muted = Color.FromArgb(91, 104, 119);
        public static Color Border = Color.FromArgb(214, 221, 230);
        public static Color BorderStrong = Color.FromArgb(160, 172, 188);
        public static Color Success = Color.FromArgb(22, 148, 98);
        public static Color SuccessSoft = Color.FromArgb(232, 247, 240);
        public static Color Warning = Color.FromArgb(190, 124, 14);
        public static Color WarningSoft = Color.FromArgb(255, 246, 224);
        public static Color Danger = Color.FromArgb(204, 61, 74);
        public static Color DangerSoft = Color.FromArgb(253, 236, 238);
        public static Color Disabled = Color.FromArgb(170, 180, 192);

        // Characters of the "Segoe MDL2 Assets" icon font (Windows 10 and 11).
        public static readonly string GlyphCheck = ((char)0xE73E).ToString();
        public static readonly string GlyphCross = ((char)0xE711).ToString();
        public static readonly string GlyphMinus = ((char)0xE738).ToString();

        public static int S(float value)
        {
            return (int)Math.Round(value * Scale);
        }

        public static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float d = Math.Max(1f, radius * 2f);
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static void Quality(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        }
    }

    /// <summary>A borderless window with a shadow, rounded corners where Windows offers them, and a drag handle.</summary>
    public class WizardForm : Form
    {
        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        public Color FrameColor = Color.FromArgb(40, 52, 72);

        public WizardForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            AutoScaleMode = AutoScaleMode.None;
            DoubleBuffered = true;
            SetStyle(ControlStyles.ResizeRedraw, true);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style |= 0x00020000 | 0x00080000; // WS_MINIMIZEBOX | WS_SYSMENU: taskbar click minimises
                cp.ClassStyle |= 0x00020000;          // CS_DROPSHADOW
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int round = 2; // DWMWCP_ROUND, Windows 11; older systems ignore the attribute
                DwmSetWindowAttribute(Handle, 33, ref round, 4);
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }

        /// <summary>Called from MouseDown of anything that should move the window.</summary>
        public void DragMove()
        {
            ReleaseCapture();
            SendMessage(Handle, 0x00A1, new IntPtr(2), IntPtr.Zero); // WM_NCLBUTTONDOWN, HTCAPTION
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (Pen pen = new Pen(FrameColor))
            {
                e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
            }
        }
    }

    /// <summary>
    /// A surface that is a button: reached with Tab, pressed with Enter or Space, announced as a
    /// button with its title. The status page's tiles were mouse-only (audit P2-8).
    /// </summary>
    public class TileSurface : Surface
    {
        /// <summary>The border at rest, and the one shown under the mouse or with the focus.</summary>
        public Color RestStroke = Color.Empty;
        public Color FocusStroke = Color.Empty;
        private bool hovered;

        public TileSurface()
        {
            SetStyle(ControlStyles.Selectable, true);
            TabStop = true;
            AccessibleRole = AccessibleRole.PushButton;
        }

        private void Restyle()
        {
            bool lit = hovered || Focused;
            Stroke = lit && !FocusStroke.IsEmpty ? FocusStroke : RestStroke;
            // The focus is a thicker border, so the keyboard user sees where they are even under the mouse.
            StrokeWidth = Focused ? 2f : 1f;
            Invalidate();
        }

        protected override void OnGotFocus(EventArgs e) { Restyle(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Restyle(); base.OnLostFocus(e); }

        protected override void OnMouseEnter(EventArgs e) { hovered = true; Restyle(); base.OnMouseEnter(e); }

        protected override void OnMouseLeave(EventArgs e)
        {
            // Moving onto a label inside the tile is not leaving it.
            hovered = ClientRectangle.Contains(PointToClient(Cursor.Position));
            Restyle();
            base.OnMouseLeave(e);
        }

        /// <summary>The labels inside report the mouse leaving them, which may be the tile's real exit.</summary>
        public void ChildMouseLeft()
        {
            if (IsDisposed) { return; }
            hovered = ClientRectangle.Contains(PointToClient(Cursor.Position));
            Restyle();
        }

        protected override bool IsInputKey(Keys keyData)
        {
            Keys key = keyData & Keys.KeyCode;
            return key == Keys.Enter || key == Keys.Space || base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space)
            {
                e.Handled = true;
                OnClick(EventArgs.Empty);
            }
            base.OnKeyDown(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            Focus();
            base.OnMouseDown(e);
        }
    }

    /// <summary>A panel that does not flicker and can draw a rounded, bordered card behind its children.</summary>
    public class Surface : Panel
    {
        public Color Fill = Color.Empty;
        public Color Stroke = Color.Empty;
        public float Radius = 0f;
        public float StrokeWidth = 1f;
        /// <summary>A coloured bar on the left edge: the mark of a notice.</summary>
        public Color AccentBar = Color.Empty;

        public Surface()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (Fill.IsEmpty && Stroke.IsEmpty)
            {
                return;
            }
            Graphics g = e.Graphics;
            Theme.Quality(g);
            float inset = StrokeWidth / 2f;
            RectangleF bounds = new RectangleF(inset, inset, Width - StrokeWidth - 0.5f, Height - StrokeWidth - 0.5f);
            using (GraphicsPath path = Theme.RoundedRectangle(bounds, Math.Max(0.5f, Radius)))
            {
                if (!Fill.IsEmpty)
                {
                    using (SolidBrush brush = new SolidBrush(Fill)) { g.FillPath(brush, path); }
                }
                if (!AccentBar.IsEmpty)
                {
                    Region previous = g.Clip;
                    g.SetClip(path, CombineMode.Intersect);
                    using (SolidBrush brush = new SolidBrush(AccentBar))
                    {
                        g.FillRectangle(brush, 0, 0, Theme.S(4), Height);
                    }
                    g.Clip = previous;
                }
                if (!Stroke.IsEmpty)
                {
                    using (Pen pen = new Pen(Stroke, StrokeWidth)) { g.DrawPath(pen, path); }
                }
            }
        }
    }

    public enum ButtonKind { Primary, Secondary, Ghost, Danger, Chrome }

    /// <summary>A flat button with rounded corners, a visible focus ring and an optional icon glyph.</summary>
    public class RoundButton : Button
    {
        public ButtonKind Kind = ButtonKind.Secondary;
        /// <summary>A character of "Segoe MDL2 Assets" drawn before the text (or alone).</summary>
        public string Glyph = "";
        public Font GlyphFont;
        private bool hover;
        private bool pressed;

        public RoundButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            Cursor = Cursors.Hand;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.Quality(g);
            Color back = Parent != null ? Parent.BackColor : Theme.Window;
            g.Clear(back);

            Color fill, text, stroke = Color.Empty;
            switch (Kind)
            {
                case ButtonKind.Primary:
                    fill = pressed ? Theme.AccentPressed : (hover ? Theme.AccentHover : Theme.Accent);
                    text = Color.White;
                    break;
                case ButtonKind.Danger:
                    fill = pressed ? Color.FromArgb(170, 44, 56) : (hover ? Color.FromArgb(218, 84, 96) : Theme.Danger);
                    text = Color.White;
                    break;
                case ButtonKind.Ghost:
                    fill = pressed ? Theme.Border : (hover ? Theme.Surface : back);
                    text = Theme.Accent;
                    break;
                case ButtonKind.Chrome:
                    fill = pressed ? Color.FromArgb(225, 230, 237) : (hover ? Color.FromArgb(238, 241, 245) : back);
                    text = Theme.Muted;
                    break;
                default:
                    fill = pressed ? Color.FromArgb(226, 231, 238) : (hover ? Theme.Surface : Theme.Window);
                    text = Theme.Text;
                    stroke = hover ? Theme.BorderStrong : Theme.Border;
                    break;
            }
            if (!Enabled)
            {
                if (Kind == ButtonKind.Primary || Kind == ButtonKind.Danger)
                {
                    fill = Color.FromArgb(205, 213, 224);
                    text = Color.White;
                }
                else
                {
                    fill = back;
                    text = Theme.Disabled;
                    if (!stroke.IsEmpty) { stroke = Theme.Border; }
                }
            }

            RectangleF bounds = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            float radius = Kind == ButtonKind.Chrome ? Theme.S(4) : Theme.S(6);
            using (GraphicsPath path = Theme.RoundedRectangle(bounds, radius))
            {
                using (SolidBrush brush = new SolidBrush(fill)) { g.FillPath(brush, path); }
                if (!stroke.IsEmpty)
                {
                    using (Pen pen = new Pen(stroke)) { g.DrawPath(pen, path); }
                }
            }
            if (Focused && ShowFocusCues && Kind != ButtonKind.Chrome)
            {
                RectangleF ring = new RectangleF(2.5f, 2.5f, Width - 5.5f, Height - 5.5f);
                using (GraphicsPath path = Theme.RoundedRectangle(ring, Math.Max(1f, radius - 2f)))
                using (Pen pen = new Pen(Kind == ButtonKind.Primary || Kind == ButtonKind.Danger ? Color.White : Theme.Accent))
                {
                    pen.DashStyle = DashStyle.Dot;
                    g.DrawPath(pen, path);
                }
            }

            TextFormatFlags flags = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine |
                TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
            bool hasGlyph = !string.IsNullOrEmpty(Glyph) && GlyphFont != null;
            bool hasText = !string.IsNullOrEmpty(Text);
            Size textSize = hasText ? TextRenderer.MeasureText(g, Text, Font, Size.Empty, flags) : Size.Empty;
            Size glyphSize = hasGlyph ? TextRenderer.MeasureText(g, Glyph, GlyphFont, Size.Empty, flags) : Size.Empty;
            int gap = hasGlyph && hasText ? Theme.S(7) : 0;
            int x = (Width - textSize.Width - glyphSize.Width - gap) / 2;
            if (hasGlyph)
            {
                Rectangle glyphBox = new Rectangle(x, 0, glyphSize.Width, Height);
                TextRenderer.DrawText(g, Glyph, GlyphFont, glyphBox, text, flags);
                x += glyphSize.Width + gap;
            }
            if (hasText)
            {
                TextRenderer.DrawText(g, Text, Font, new Rectangle(x, 0, textSize.Width + 2, Height - 1), text, flags);
            }
        }
    }

    /// <summary>The list of wizard steps in the sidebar: done, current, to come.</summary>
    public class StepList : Control
    {
        private string[] items = new string[0];
        private int current;
        public Font GlyphFont;
        public Font StrongFont;

        public StepList()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            TabStop = false;
        }

        public string[] Items { get { return items; } set { items = value ?? new string[0]; Invalidate(); } }
        public int Current { get { return current; } set { current = value; Invalidate(); } }

        public int RowHeight { get { return Theme.S(38); } }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.Quality(g);
            g.Clear(BackColor);
            int row = RowHeight;
            int dot = Theme.S(22);
            int left = Theme.S(22);
            for (int i = 0; i < items.Length; i++)
            {
                int top = i * row;
                bool isCurrent = i == current;
                bool isDone = i < current;
                if (isCurrent)
                {
                    RectangleF highlight = new RectangleF(Theme.S(10), top + Theme.S(2), Width - Theme.S(20), row - Theme.S(4));
                    using (GraphicsPath path = Theme.RoundedRectangle(highlight, Theme.S(6)))
                    using (SolidBrush brush = new SolidBrush(Theme.SidebarRaised))
                    {
                        g.FillPath(brush, path);
                    }
                }
                RectangleF circle = new RectangleF(left, top + (row - dot) / 2f, dot, dot);
                if (isDone)
                {
                    using (SolidBrush brush = new SolidBrush(Color.FromArgb(30, 94, 170))) { g.FillEllipse(brush, circle); }
                    if (GlyphFont != null)
                    {
                        TextRenderer.DrawText(g, Theme.GlyphCheck, GlyphFont, Rectangle.Round(circle), Color.White,
                            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
                    }
                }
                else if (isCurrent)
                {
                    using (SolidBrush brush = new SolidBrush(Theme.Accent)) { g.FillEllipse(brush, circle); }
                    TextRenderer.DrawText(g, (i + 1).ToString(), StrongFont ?? Font, Rectangle.Round(circle), Color.White,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
                }
                else
                {
                    using (Pen pen = new Pen(Color.FromArgb(70, 86, 116), Math.Max(1f, Theme.Scale)))
                    {
                        g.DrawEllipse(pen, circle.X + 0.5f, circle.Y + 0.5f, circle.Width - 1f, circle.Height - 1f);
                    }
                    TextRenderer.DrawText(g, (i + 1).ToString(), Font, Rectangle.Round(circle), Theme.SidebarMuted,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
                }
                Rectangle label = new Rectangle(left + dot + Theme.S(12), top, Width - left - dot - Theme.S(22), row);
                Color color = isCurrent ? Color.White : (isDone ? Theme.SidebarText : Theme.SidebarMuted);
                TextRenderer.DrawText(g, items[i], isCurrent && StrongFont != null ? StrongFont : Font, label, color,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
            }
        }
    }

    public enum StatusKind { Ok, Warning, Error, Info, Pending, Running, Skipped }

    /// <summary>A small round status mark: a tick, an exclamation mark, a cross, a ring that turns.</summary>
    public class StatusGlyph : Control
    {
        private StatusKind kind = StatusKind.Pending;
        private Timer timer;
        private float angle;
        public Font GlyphFont;
        /// <summary>What each kind is called, in the interface's language (set once by the window, in enum order).</summary>
        public static string[] KindNames;

        public StatusGlyph()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                ControlStyles.SupportsTransparentBackColor, true);
            TabStop = false;
            AccessibleRole = AccessibleRole.Graphic;
            NameKind();
        }

        /// <summary>A screen reader hears what the mark says, not nothing (audit P2-8).</summary>
        private void NameKind()
        {
            int index = (int) kind;
            AccessibleName = KindNames != null && index < KindNames.Length ? KindNames[index] : kind.ToString();
        }

        public StatusKind Kind
        {
            get { return kind; }
            set
            {
                kind = value;
                NameKind();
                if (kind == StatusKind.Running && timer == null && IsHandleCreated)
                {
                    StartTimer();
                }
                if (kind != StatusKind.Running && timer != null)
                {
                    timer.Stop(); timer.Dispose(); timer = null;
                }
                Invalidate();
            }
        }

        private void StartTimer()
        {
            timer = new Timer();
            timer.Interval = 60;
            timer.Tick += delegate { angle = (angle + 24f) % 360f; Invalidate(); };
            timer.Start();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (kind == StatusKind.Running && timer == null) { StartTimer(); }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && timer != null) { timer.Stop(); timer.Dispose(); timer = null; }
            base.Dispose(disposing);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.Quality(g);
            g.Clear(Parent != null ? Parent.BackColor : Theme.Window);
            float size = Math.Min(Width, Height) - 1f;
            RectangleF circle = new RectangleF((Width - size) / 2f, (Height - size) / 2f, size, size);
            Color fill; string glyph;
            switch (kind)
            {
                case StatusKind.Ok: fill = Theme.Success; glyph = Theme.GlyphCheck; break;
                case StatusKind.Warning: fill = Theme.Warning; glyph = ""; break;
                case StatusKind.Error: fill = Theme.Danger; glyph = Theme.GlyphCross; break;
                case StatusKind.Info: fill = Theme.Accent; glyph = ""; break;
                case StatusKind.Skipped: fill = Theme.Disabled; glyph = Theme.GlyphMinus; break;
                default: fill = Color.Empty; glyph = ""; break;
            }
            if (kind == StatusKind.Pending || kind == StatusKind.Running)
            {
                float w = Math.Max(1.5f, size / 9f);
                RectangleF ring = RectangleF.Inflate(circle, -w / 2f, -w / 2f);
                using (Pen pen = new Pen(Theme.Border, w)) { g.DrawEllipse(pen, ring); }
                if (kind == StatusKind.Running)
                {
                    using (Pen pen = new Pen(Theme.Accent, w))
                    {
                        pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                        g.DrawArc(pen, ring, angle - 90f, 100f);
                    }
                }
                return;
            }
            using (SolidBrush brush = new SolidBrush(fill)) { g.FillEllipse(brush, circle); }
            if (kind == StatusKind.Warning || kind == StatusKind.Info)
            {
                // An exclamation mark, or the same turned over for "i": the icon font
                // only has them already circled.
                float cx = circle.X + circle.Width / 2f;
                float w = Math.Max(1.6f, size / 8.5f);
                float top = circle.Y + size * 0.24f, bottom = circle.Y + size * 0.76f;
                float dot = kind == StatusKind.Warning ? bottom : top;
                float from = kind == StatusKind.Warning ? top : circle.Y + size * 0.44f;
                float to = kind == StatusKind.Warning ? circle.Y + size * 0.56f : bottom;
                using (Pen pen = new Pen(Color.White, w))
                {
                    pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                    g.DrawLine(pen, cx, from, cx, to);
                }
                using (SolidBrush brush = new SolidBrush(Color.White))
                {
                    g.FillEllipse(brush, cx - w * 0.6f, dot - w * 0.6f, w * 1.2f, w * 1.2f);
                }
                return;
            }
            if (GlyphFont != null)
            {
                TextRenderer.DrawText(g, glyph, GlyphFont, Rectangle.Round(circle), Color.White,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            }
        }
    }

    /// <summary>A thin flat progress bar.</summary>
    public class ThinProgress : Control
    {
        private int value;
        public Color BarColor = Theme.Accent;

        public ThinProgress()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            TabStop = false;
        }

        public int Value
        {
            get { return value; }
            set { this.value = Math.Max(0, Math.Min(100, value)); Invalidate(); }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.Quality(g);
            g.Clear(Parent != null ? Parent.BackColor : Theme.Window);
            RectangleF track = new RectangleF(0, 0, Width - 1, Height - 1);
            float radius = Height / 2f;
            using (GraphicsPath path = Theme.RoundedRectangle(track, radius))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(228, 233, 240)))
            {
                g.FillPath(brush, path);
            }
            if (value > 0)
            {
                float width = Math.Max(Height, (Width - 1) * value / 100f);
                using (GraphicsPath path = Theme.RoundedRectangle(new RectangleF(0, 0, width, Height - 1), radius))
                using (SolidBrush brush = new SolidBrush(BarColor))
                {
                    g.FillPath(brush, path);
                }
            }
        }
    }

    /// <summary>One choice out of several, with room to say what choosing it means.</summary>
    public class OptionCard : Control
    {
        private bool isChecked;
        private bool hover;
        public string Title = "";
        public string Description = "";
        public string Badge = "";
        public Font TitleFont;
        public Font BadgeFont;
        public event EventHandler CheckedChanged;

        public OptionCard()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = true;
            Cursor = Cursors.Hand;
        }

        public bool Checked
        {
            get { return isChecked; }
            set
            {
                if (isChecked == value) { return; }
                isChecked = value;
                Invalidate();
                if (IsHandleCreated) { AccessibilityNotifyClients(AccessibleEvents.StateChange, -1); }
                if (CheckedChanged != null) { CheckedChanged(this, EventArgs.Empty); }
            }
        }

        // A screen reader hears a radio button named after the card, with its description and
        // its checked state - it used to hear an unnamed client area (audit P2-8).
        protected override AccessibleObject CreateAccessibilityInstance() { return new CardAccessibility(this); }

        private class CardAccessibility : ControlAccessibleObject
        {
            private readonly OptionCard card;
            public CardAccessibility(OptionCard owner) : base(owner) { card = owner; }
            public override AccessibleRole Role { get { return AccessibleRole.RadioButton; } }
            public override string Name { get { return card.Title; } set { } }
            public override string Description { get { return card.Description; } }
            public override string DefaultAction { get { return "Select"; } }
            public override void DoDefaultAction() { card.Checked = true; }
            public override AccessibleStates State
            {
                get
                {
                    AccessibleStates states = AccessibleStates.Focusable;
                    if (card.Focused) { states |= AccessibleStates.Focused; }
                    if (card.isChecked) { states |= AccessibleStates.Checked; }
                    if (!card.Enabled) { states |= AccessibleStates.Unavailable; }
                    return states;
                }
            }
        }

        protected override bool IsInputKey(Keys keyData)
        {
            Keys key = keyData & Keys.KeyCode;
            if (key == Keys.Up || key == Keys.Down || key == Keys.Left || key == Keys.Right) { return true; }
            return base.IsInputKey(keyData);
        }

        /// <summary>Arrow keys move through the cards of one group, the way radio buttons do.</summary>
        private void MoveInGroup(int step)
        {
            if (Parent == null) { return; }
            var cards = new System.Collections.Generic.List<OptionCard>();
            foreach (Control control in Parent.Controls)
            {
                OptionCard other = control as OptionCard;
                if (other != null && other.Visible && other.Enabled) { cards.Add(other); }
            }
            cards.Sort((a, b) => a.Top != b.Top ? a.Top.CompareTo(b.Top) : a.Left.CompareTo(b.Left));
            int index = cards.IndexOf(this);
            if (index < 0 || cards.Count < 2) { return; }
            OptionCard next = cards[(index + step + cards.Count) % cards.Count];
            next.Focus();
            next.Checked = true;
        }

        private int TextLeft { get { return Theme.S(44); } }
        private int Pad { get { return Theme.S(12); } }

        private const TextFormatFlags Wrap = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;

        /// <summary>The height this card needs at the given width.</summary>
        public int MeasureHeight(int width)
        {
            int textWidth = Math.Max(10, width - TextLeft - Pad);
            int title = TextRenderer.MeasureText(Title, TitleFont ?? Font, new Size(textWidth, 10000), Wrap).Height;
            int body = string.IsNullOrEmpty(Description) ? 0 :
                TextRenderer.MeasureText(Description, Font, new Size(textWidth, 10000), Wrap).Height + Theme.S(3);
            return Pad + title + body + Pad;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnClick(EventArgs e)
        {
            Focus();
            Checked = true;
            base.OnClick(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter)
            {
                Checked = true;
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.Down || e.KeyCode == Keys.Right) { MoveInGroup(1); e.Handled = true; }
            else if (e.KeyCode == Keys.Up || e.KeyCode == Keys.Left) { MoveInGroup(-1); e.Handled = true; }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.Quality(g);
            g.Clear(Parent != null ? Parent.BackColor : Theme.Window);
            float stroke = isChecked ? Math.Max(1.5f, 1.6f * Theme.Scale) : 1f;
            RectangleF bounds = new RectangleF(stroke / 2f, stroke / 2f, Width - stroke - 0.5f, Height - stroke - 0.5f);
            using (GraphicsPath path = Theme.RoundedRectangle(bounds, Theme.S(8)))
            {
                Color fill = isChecked ? Theme.AccentSoft : (hover ? Theme.Surface : Theme.Window);
                using (SolidBrush brush = new SolidBrush(fill)) { g.FillPath(brush, path); }
                using (Pen pen = new Pen(isChecked ? Theme.Accent : (hover || Focused ? Theme.BorderStrong : Theme.Border), stroke))
                {
                    g.DrawPath(pen, path);
                }
            }
            // The radio mark.
            float r = Theme.S(16);
            RectangleF radio = new RectangleF(Theme.S(15), Pad + Theme.S(2), r, r);
            using (Pen pen = new Pen(isChecked ? Theme.Accent : Theme.BorderStrong, Math.Max(1.3f, 1.4f * Theme.Scale)))
            {
                g.DrawEllipse(pen, radio);
            }
            if (isChecked)
            {
                RectangleF inner = RectangleF.Inflate(radio, -r / 4f, -r / 4f);
                using (SolidBrush brush = new SolidBrush(Theme.Accent)) { g.FillEllipse(brush, inner); }
            }

            int textWidth = Math.Max(10, Width - TextLeft - Pad);
            Font titleFont = TitleFont ?? Font;
            Size titleSize = TextRenderer.MeasureText(g, Title, titleFont, new Size(textWidth, 10000), Wrap);
            TextRenderer.DrawText(g, Title, titleFont, new Rectangle(TextLeft, Pad, textWidth, titleSize.Height), Theme.Text, Wrap);
            if (!string.IsNullOrEmpty(Badge) && BadgeFont != null)
            {
                Size badgeSize = TextRenderer.MeasureText(g, Badge, BadgeFont, Size.Empty, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                int bw = badgeSize.Width + Theme.S(14);
                int bh = badgeSize.Height + Theme.S(4);
                RectangleF pill = new RectangleF(Width - Pad - bw, Pad - Theme.S(1), bw, bh);
                using (GraphicsPath path = Theme.RoundedRectangle(pill, bh / 2f))
                using (SolidBrush brush = new SolidBrush(isChecked ? Theme.Accent : Theme.Surface))
                {
                    g.FillPath(brush, path);
                }
                TextRenderer.DrawText(g, Badge, BadgeFont, Rectangle.Round(pill), isChecked ? Color.White : Theme.Muted,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            }
            if (!string.IsNullOrEmpty(Description))
            {
                Rectangle body = new Rectangle(TextLeft, Pad + titleSize.Height + Theme.S(3), textWidth, Height - Pad - titleSize.Height);
                TextRenderer.DrawText(g, Description, Font, body, Theme.Muted, Wrap);
            }
        }
    }

    /// <summary>The product mark drawn in the sidebar when the icon file is not there to load.</summary>
    public class LogoMark : Control
    {
        public Image Picture;

        public LogoMark()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            TabStop = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.Quality(g);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Sidebar);
            RectangleF bounds = new RectangleF(0, 0, Width - 1, Height - 1);
            if (Picture != null)
            {
                using (GraphicsPath path = Theme.RoundedRectangle(bounds, Width / 4.5f))
                {
                    g.SetClip(path);
                    g.DrawImage(Picture, new Rectangle(0, 0, Width, Height));
                    g.ResetClip();
                }
                return;
            }
            using (GraphicsPath path = Theme.RoundedRectangle(bounds, Width / 4.5f))
            using (LinearGradientBrush brush = new LinearGradientBrush(bounds, Color.FromArgb(74, 163, 255), Color.FromArgb(31, 95, 210), 45f))
            {
                g.FillPath(brush, path);
            }
            float u = Width / 10f;
            PointF[] play = { new PointF(3.9f * u, 2.9f * u), new PointF(7.2f * u, 5f * u), new PointF(3.9f * u, 7.1f * u) };
            using (SolidBrush brush = new SolidBrush(Color.White)) { g.FillPolygon(brush, play); }
        }
    }
}
