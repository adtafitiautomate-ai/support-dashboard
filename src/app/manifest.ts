import type { MetadataRoute } from "next";

/** Lets agents "Add to Home screen" and open Tuongee full-screen like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tuongee",
    short_name: "Tuongee",
    description: "WhatsApp customer care inbox",
    start_url: "/inbox",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
