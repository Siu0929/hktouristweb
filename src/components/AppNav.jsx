"use client";

import Link from "next/link";
import { Toilet } from "lucide-react";
import { useTranslations } from "@/contexts/LocaleContext";

export default function AppNav({ active }) {
  const t = useTranslations("common");

  const items = [
    { href: "/toilets", id: "toilets", label: t("navToilets"), Icon: Toilet },
  ];

  return (
    <nav className="flex items-center gap-1 shrink-0" aria-label="App navigation">
      {items.map(({ href, id, label, Icon }) => (
        <Link
          key={id}
          href={href}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] sm:text-xs font-medium transition ${
            active === id
              ? "bg-zinc-900 text-white"
              : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
