import type { Metadata } from "next";
import { headers } from "next/headers";
import { SiteHeader } from "../components/SiteHeader";
import "./globals.css";

const title = "채점결 · 논술형 평가 작업실";
const description =
  "평가 준비부터 채점 검토와 학생 피드백까지 한 흐름으로 이어 주는 교사용 작업실";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(
    host ? `${protocol}://${host}` : "http://localhost:3000",
  );

  return {
    metadataBase,
    title,
    description,
    openGraph: {
      type: "website",
      locale: "ko_KR",
      title,
      description,
      images: [{ url: "/og.png", width: 1730, height: 910, alt: "채점결" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <div className="site-frame">
          <SiteHeader />
          {children}
        </div>
      </body>
    </html>
  );
}
