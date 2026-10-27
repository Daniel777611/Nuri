// Web build: no font files to download. Each Noto Sans SC face is about
// 10.5 MB, and the five came to 53 MB on every visit. On a phone that held
// back the images and the API calls behind them, which left the Android
// shell on a spinner. Instead, the same family names resolve to the
// system's own Chinese sans: Noto Sans CJK on Android, PingFang on Apple,
// Microsoft YaHei on Windows. If none is found, the browser's default sans
// is used. Styles keep naming "NotoSansSC_400Regular" and so on unchanged.
export const TEXT_FONTS = {};

const FACES: [family: string, weight: number, local: string[]][] = [
  ["NotoSansSC_400Regular", 400, ["NotoSansCJKsc-Regular", "NotoSansSC-Regular", "PingFangSC-Regular", "MicrosoftYaHei"]],
  ["NotoSansSC_500Medium", 500, ["NotoSansCJKsc-Medium", "NotoSansSC-Medium", "PingFangSC-Medium", "MicrosoftYaHei"]],
  ["NotoSansSC_600SemiBold", 600, ["NotoSansCJKsc-Bold", "NotoSansSC-SemiBold", "PingFangSC-Semibold", "MicrosoftYaHei-Bold"]],
  ["NotoSansSC_700Bold", 700, ["NotoSansCJKsc-Bold", "NotoSansSC-Bold", "PingFangSC-Semibold", "MicrosoftYaHei-Bold"]],
  ["NotoSansSC_900Black", 900, ["NotoSansCJKsc-Black", "NotoSansSC-Black", "PingFangSC-Semibold", "MicrosoftYaHei-Bold"]],
];
// Full names as well as PostScript names: browsers match local() on either.
const SHARED = ["Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Source Han Sans SC"];

if (typeof document !== "undefined" && !document.getElementById("nuri-text-fonts")) {
  const style = document.createElement("style");
  style.id = "nuri-text-fonts";
  style.textContent = FACES.map(([family, weight, names]) =>
    `@font-face{font-family:"${family}";font-weight:${weight};font-display:swap;src:${
      [...names, ...SHARED].map((name) => `local("${name}")`).join(",")
    };}`).join("\n");
  document.head.appendChild(style);
}
