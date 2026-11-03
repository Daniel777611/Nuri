// Design tokens centralized — keeps screens consistent with design_guidelines.json.
export const colors = {
  surface: "transparent",
  onSurface: "#3D3340",
  surfaceSecondary: "rgba(255,248,242,0.76)",
  onSurfaceSecondary: "#5D5060",
  surfaceTertiary: "rgba(255,248,242,0.44)",
  onSurfaceTertiary: "#5D5060",
  surfaceInverse: "#292524",
  onSurfaceInverse: "#FFFFFF",
  brand: "#EB8183",
  brandPrimary: "#EB8183",
  onBrandPrimary: "#FFFFFF",
  brandSecondary: "#EF999B",
  brandTertiary: "rgba(235,129,131,0.23)",
  onBrandTertiary: "#5D5060",
  success: "#34D399",
  warning: "#FBBF24",
  error: "#E15241",
  info: "#60A5FA",
  border: "rgba(93,80,96,0.18)",
  borderStrong: "rgba(93,80,96,0.25)",
  divider: "rgba(93,80,96,0.12)",
  muted: "#5D5060",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 24,
  lg: 28,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

export const radius = {
  sm: 6,
  md: 12,
  lg: 16,
  pill: 999,
};

export const type = {
  sm: 12,
  base: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
};

const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL?.replace(/\/$/, "");

// Native builds have no web origin. Keep all requests on the existing backend.
export const API = backendUrl ? `${backendUrl}/api` : "https://nurifam.app/api";
