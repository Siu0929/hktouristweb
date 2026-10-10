import { Geist, Geist_Mono } from "next/font/google";
import { LocaleProvider } from "@/contexts/LocaleContext";
import ErrorBoundary from "@/components/ErrorBoundary";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "HK Fragrant Compass",
  description: "Find public toilets across Hong Kong using CSDI WFS and DATA.GOV.HK APIs",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="zh-Hant"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col safe-top">
        <ErrorBoundary fallbackTitle="Page failed to load — please try again.">
          <LocaleProvider>{children}</LocaleProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
