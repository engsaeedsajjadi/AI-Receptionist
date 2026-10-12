import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI Receptionist Enterprise",
    short_name: "AI Receptionist",
    description: "منشی هوشمند چندمستاجری برای تماس، CRM، نوبت‌دهی و پایگاه دانش",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f1f5f9",
    theme_color: "#0f172a",
    lang: "fa",
    dir: "rtl",
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
