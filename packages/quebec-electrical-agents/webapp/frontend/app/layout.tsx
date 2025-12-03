import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Agents Électriques Québec | Système PGI",
  description: "Système d'agents IA pour l'industrie électrique québécoise - CEQ, RBQ, RSST, CSA",
  keywords: ["electrical", "quebec", "CEQ", "RBQ", "RSST", "PGI", "dashboard", "AI agents"],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr" className="dark">
      <body className={`${inter.className} cyber-container`}>
        {children}
      </body>
    </html>
  );
}
