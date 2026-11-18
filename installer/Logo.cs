// FirstCut - le logo (tuile orange, clip coupe en deux en diagonale).
//
// Sert a l'installateur (en-tete) et a build.ps1 (icone .ico).
// Meme dessin que le symbole "i-logo" du panneau, sur une grille de 24.
// Fichier en ASCII : il est aussi compile par Add-Type de PowerShell 5.1.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class FirstCutLogo
{
    public static readonly Color Orange = Color.FromArgb(242, 106, 46);
    public static readonly Color OrangeLight = Color.FromArgb(255, 160, 96);
    public static readonly Color OrangeDark = Color.FromArgb(222, 78, 24);

    public static GraphicsPath RoundRect(RectangleF r, float radius)
    {
        GraphicsPath p = new GraphicsPath();
        float d = Math.Min(radius * 2f, Math.Min(r.Width, r.Height));
        if (d <= 0.5f)
        {
            p.AddRectangle(r);
            return p;
        }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    /// <summary>Tuile orange arrondie avec la marque blanche.</summary>
    public static void Draw(Graphics g, RectangleF box)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        using (GraphicsPath tile = RoundRect(box, box.Width * 0.24f))
        using (LinearGradientBrush b = new LinearGradientBrush(
            new PointF(box.X, box.Y), new PointF(box.Right, box.Bottom), OrangeLight, OrangeDark))
        {
            g.FillPath(b, tile);
        }
        DrawMark(g, box, Color.White);
    }

    /// <summary>Les deux moities du clip : x de 3 a 21, y de 5,5 a 18,5.</summary>
    public static void DrawMark(Graphics g, RectangleF box, Color color)
    {
        float k = box.Width * 0.60f / 18f;
        float ox = box.X + (box.Width - 18f * k) / 2f - 3f * k;
        float oy = box.Y + (box.Height - 13f * k) / 2f - 5.5f * k;
        PointF[] left = {
            new PointF(ox + 3f * k, oy + 5.5f * k), new PointF(ox + 11.8f * k, oy + 5.5f * k),
            new PointF(ox + 7.4f * k, oy + 18.5f * k), new PointF(ox + 3f * k, oy + 18.5f * k)
        };
        PointF[] right = {
            new PointF(ox + 16.6f * k, oy + 5.5f * k), new PointF(ox + 21f * k, oy + 5.5f * k),
            new PointF(ox + 21f * k, oy + 18.5f * k), new PointF(ox + 12.2f * k, oy + 18.5f * k)
        };
        using (SolidBrush b = new SolidBrush(color))
        {
            g.FillPolygon(b, left);
            g.FillPolygon(b, right);
        }
    }

    public static Bitmap Render(int size)
    {
        Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            float pad = size <= 24 ? 0f : size * 0.04f;
            Draw(g, new RectangleF(pad, pad, size - 2f * pad, size - 2f * pad));
        }
        return bmp;
    }

    /// <summary>Icone Windows multi-tailles (DIB 32 bits, PNG pour 256).</summary>
    public static void SaveIco(string path)
    {
        int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 128, 256 };
        byte[][] data = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++)
        {
            using (Bitmap bmp = Render(sizes[i]))
            {
                data[i] = sizes[i] >= 256 ? Png(bmp) : Dib(bmp);
            }
        }
        using (FileStream fs = File.Create(path))
        using (BinaryWriter w = new BinaryWriter(fs))
        {
            w.Write((short)0);
            w.Write((short)1);
            w.Write((short)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                byte dim = (byte)(sizes[i] >= 256 ? 0 : sizes[i]);
                w.Write(dim);
                w.Write(dim);
                w.Write((byte)0);
                w.Write((byte)0);
                w.Write((short)1);
                w.Write((short)32);
                w.Write(data[i].Length);
                w.Write(offset);
                offset += data[i].Length;
            }
            for (int i = 0; i < sizes.Length; i++) w.Write(data[i]);
        }
    }

    static byte[] Png(Bitmap bmp)
    {
        using (MemoryStream ms = new MemoryStream())
        {
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }
    }

    static byte[] Dib(Bitmap bmp)
    {
        int s = bmp.Width;
        int maskStride = ((s + 31) / 32) * 4;
        using (MemoryStream ms = new MemoryStream())
        using (BinaryWriter w = new BinaryWriter(ms))
        {
            w.Write(40);
            w.Write(s);
            w.Write(s * 2);
            w.Write((short)1);
            w.Write((short)32);
            w.Write(0);
            w.Write(s * s * 4 + maskStride * s);
            w.Write(0);
            w.Write(0);
            w.Write(0);
            w.Write(0);
            for (int y = s - 1; y >= 0; y--)
            {
                for (int x = 0; x < s; x++)
                {
                    Color c = bmp.GetPixel(x, y);
                    w.Write(c.B);
                    w.Write(c.G);
                    w.Write(c.R);
                    w.Write(c.A);
                }
            }
            w.Write(new byte[maskStride * s]);
            return ms.ToArray();
        }
    }
}
