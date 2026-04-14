"use client";

import { type ReactNode } from "react";
import { LocaleProvider } from "@/i18n/context";

export default function Providers({ children }: { children: ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}
