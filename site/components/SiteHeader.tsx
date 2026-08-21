"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/", label: "오늘", match: (path: string) => path === "/" },
  { href: "/assessments", label: "평가", match: (path: string) => path.startsWith("/assessments") },
  { href: "/classes", label: "학급", match: (path: string) => path.startsWith("/classes") },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="topbar">
      <Link className="brand" href="/" aria-label="채점결 첫 화면">
        <span className="brand-mark" aria-hidden="true">결</span>
        <span>
          <strong>채점결</strong>
          <small>논술형 평가 작업실</small>
        </span>
      </Link>
      <nav className="topnav" aria-label="주요 메뉴">
        {navigation.map((item) => (
          <Link
            className={item.match(pathname) ? "is-current" : undefined}
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="header-end">
        <span className="preview-badge">디자인 미리보기</span>
        <div className="teacher-chip" aria-label="사용자 김 선생님">
          <span>김</span>
          <strong>김 선생님</strong>
        </div>
      </div>
    </header>
  );
}
