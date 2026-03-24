import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "Inter, Arial, sans-serif",
          margin: 0,
          background: "#eef3ee",
          color: "#1f2a21"
        }}
      >
        <style>{`
          :root {
            --forest-900: #173a2b;
            --forest-800: #1f4d37;
            --forest-700: #2c6a49;
            --forest-100: #e8f3ec;
            --surface: #ffffff;
            --surface-soft: #f7fbf8;
            --border: #cfe0d4;
            --text-soft: #4a6150;
          }
          * { box-sizing: border-box; }
          h1, h2, h3 { color: var(--forest-900); letter-spacing: 0.1px; }
          p, li, label, span { color: #213528; }
          main { color: #1f2a21; }
          section {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 14px;
            padding: 14px;
            box-shadow: 0 6px 20px rgba(26, 62, 44, 0.06);
            margin-bottom: 12px;
          }
          input, select, textarea, button {
            font: inherit;
            padding: 9px 10px;
            border-radius: 10px;
            border: 1px solid var(--border);
          }
          input, select, textarea {
            background: #fff;
            color: #1f2a21;
          }
          input:focus, select:focus, textarea:focus {
            outline: none;
            border-color: var(--forest-700);
            box-shadow: 0 0 0 3px rgba(44, 106, 73, 0.16);
          }
          button {
            background: linear-gradient(180deg, var(--forest-700), var(--forest-800));
            color: #fff;
            border-color: var(--forest-800);
            cursor: pointer;
            font-weight: 600;
          }
          button:hover { filter: brightness(1.04); }
          button:disabled {
            opacity: 0.65;
            cursor: not-allowed;
          }
          a {
            color: var(--forest-700);
            font-weight: 600;
          }
          a:hover { color: var(--forest-800); }
          code {
            background: var(--forest-100);
            color: var(--forest-900);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 2px 6px;
          }
          table {
            background: #fff;
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid var(--border);
          }
          th {
            background: var(--forest-100);
            color: var(--forest-900);
            font-weight: 700;
          }
          td { background: #fff; }
          tr:nth-child(even) td { background: var(--surface-soft); }
        `}</style>
        {children}
      </body>
    </html>
  );
}
