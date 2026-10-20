using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using Termilly.Setup.Engine;

namespace Termilly.Setup.Pages;

public partial class InstallingPage : UserControl
{
    private static readonly (Step Step, string Name)[] Lines =
    {
        (Step.Runtime, ".NET 10 Desktop Runtime"),
        (Step.WebView2, "WebView2 Runtime"),
        (Step.Files, "Termilly files"),
        (Step.Windows, "Shortcuts, Explorer menu and uninstall entry"),
        (Step.Check, "Checking the installation"),
    };

    /// <summary>A task line's state: to do (a dot), under way (a spinner, bold) or done (a tick).</summary>
    private enum TaskState
    {
        ToDo,
        Now,
        Done,
    }

    /// <summary>A task line's state box, the gap to its name, its note's size and the gap below it.</summary>
    private const double StateSize = 16;
    private static readonly Thickness NameMargin = new(10, 0, 0, 0);
    private const double NoteSize = 11;
    private static readonly Thickness LineMargin = new(0, 0, 0, 9);
    /// <summary>The tick, the spinner (its dashes and one turn's time) and the dot.</summary>
    private const double TickSize = 12;
    private const double TickStroke = 1.8;
    private const double SpinnerSize = 11;
    private const double SpinnerStroke = 2;
    private static readonly DoubleCollection SpinnerDashes = new() { 3.5, 2 };
    private static readonly TimeSpan SpinnerTurn = TimeSpan.FromSeconds(0.9);
    private const double FullTurn = 360;
    private const double DotSize = 6;
    private static readonly Point Middle = new(0.5, 0.5);

    private readonly Dictionary<Step, (Grid State, TextBlock Name, TextBlock Note)> _lines = new();
    private Step _current = Step.Runtime;

    public InstallingPage()
    {
        InitializeComponent();
        foreach (var (step, name) in Lines)
        {
            var state = new Grid { Width = StateSize, Height = StateSize, VerticalAlignment = VerticalAlignment.Center };
            var label = new TextBlock { Text = name, Margin = NameMargin, VerticalAlignment = VerticalAlignment.Center };
            var note = new TextBlock { FontFamily = (FontFamily)FindResource(ThemeBrushes.MonoFont), FontSize = NoteSize, VerticalAlignment = VerticalAlignment.Center };
            note.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.Faint);
            var row = new DockPanel { Margin = LineMargin };
            DockPanel.SetDock(state, Dock.Left);
            DockPanel.SetDock(note, Dock.Right);
            row.Children.Add(state);
            row.Children.Add(note);
            row.Children.Add(label);
            Tasks.Children.Add(row);
            _lines[step] = (state, label, note);
            Set(step, TaskState.ToDo);
        }
        LogText.Text = Log.All;
        Log.Added += OnLog;
        Unloaded += (_, _) => Log.Added -= OnLog;
        Set(Step.Runtime, TaskState.Now);
    }

    private void OnLog(string line) => Dispatcher.BeginInvoke(new Action(() =>
    {
        LogText.AppendText(line + Environment.NewLine);
        LogText.ScrollToEnd();
    }));

    internal void Report(Progress p)
    {
        Now.Text = p.Text;
        if (p.Fraction < 0)
        {
            Bar.IsIndeterminate = true;
        }
        else
        {
            Bar.IsIndeterminate = false;
            Bar.Value = p.Fraction;
        }
        if (p.Step != _current)
        {
            Set(_current, TaskState.Done);
            _current = p.Step;
        }
        Set(p.Step, p.Done ? TaskState.Done : TaskState.Now, p.Note);
        if (p.Done && p.Step != Step.Check)
        {
            var next = (Step)((int)p.Step + 1);
            Set(next, TaskState.Now);
            _current = next;
        }
    }

    /// <summary>Shows a task line's state, and its note when there's one.</summary>
    private void Set(Step step, TaskState state, string? note = null)
    {
        var (box, name, noteText) = _lines[step];
        box.Children.Clear();
        if (note is not null)
        {
            noteText.Text = note;
        }
        switch (state)
        {
            case TaskState.Done:
                var tick = new Path
                {
                    Data = Geometry.Parse(Glyphs.Tick), StrokeThickness = TickStroke, Width = TickSize, Height = TickSize,
                    StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round,
                };
                tick.SetResourceReference(Shape.StrokeProperty, ThemeBrushes.Ok);
                box.Children.Add(tick);
                name.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.Text);
                name.FontWeight = FontWeights.Normal;
                break;
            case TaskState.Now:
                var arc = new Ellipse
                {
                    Width = SpinnerSize, Height = SpinnerSize, StrokeThickness = SpinnerStroke, StrokeDashArray = SpinnerDashes,
                    RenderTransformOrigin = Middle,
                };
                arc.SetResourceReference(Shape.StrokeProperty, ThemeBrushes.Accent);
                var spin = new RotateTransform();
                arc.RenderTransform = spin;
                spin.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(0, FullTurn, SpinnerTurn) { RepeatBehavior = RepeatBehavior.Forever });
                box.Children.Add(arc);
                name.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.TextStrong);
                name.FontWeight = FontWeights.Medium;
                break;
            default:
                var dot = new Ellipse { Width = DotSize, Height = DotSize };
                dot.SetResourceReference(Shape.FillProperty, ThemeBrushes.Faint);
                box.Children.Add(dot);
                name.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.Muted);
                name.FontWeight = FontWeights.Normal;
                break;
        }
    }
}
