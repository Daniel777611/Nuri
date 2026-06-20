// Design tokens centralized — keeps screens consistent with design_guidelines.json.
export const colors = {
  surface: "#FAFAF9",
  onSurface: "#1C1917",
  surfaceSecondary: "#FFFFFF",
  onSurfaceSecondary: "#292524",
  surfaceTertiary: "#F5F5F4",
  onSurfaceTertiary: "#44403C",
  surfaceInverse: "#292524",
  onSurfaceInverse: "#FFFFFF",
  brand: "#FF7A59",
  brandPrimary: "#FF7A59",
  onBrandPrimary: "#FFFFFF",
  brandSecondary: "#FF8A6C",
  brandTertiary: "#FFF1EE",
  onBrandTertiary: "#9E3C22",
  success: "#34D399",
  warning: "#FBBF24",
  error: "#E15241",
  info: "#60A5FA",
  border: "#E7E5E4",
  borderStrong: "#D6D3D1",
  divider: "#F5F5F4",
  muted: "#78716C",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
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

export const API = process.env.EXPO_PUBLIC_BACKEND_URL + "/api";
