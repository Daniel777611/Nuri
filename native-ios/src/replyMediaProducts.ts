export type PriceOffer = {
  title: string;
  retailer: string;
  url: string;
  image_url?: string;
  price_amount?: string;
  currency?: string;
  availability: "in_stock" | "out_of_stock" | "unknown";
};

export const PRODUCT_MEDIA_COPY = {
  en: {
    heading: "Retailer prices",
    checked: "Checked",
    best: "Lowest verified price for the same item",
    priceUnknown: "Open retailer for price",
    inStock: "In stock when checked",
    outOfStock: "Unavailable when checked",
    retailer: "Open retailer",
    checkout: "Shipping, tax and any discounts can change the total. Confirm it at checkout.",
    medication: "Pricing only. Ask a pharmacist whether this product is suitable.",
  },
  "zh-CN": {
    heading: "商家价格",
    checked: "查询于",
    best: "同款已核实的最低商品价",
    priceUnknown: "打开商家查看价格",
    inStock: "查询时有货",
    outOfStock: "查询时无现货",
    retailer: "打开商家",
    checkout: "运费、税费及折扣会影响总价，请在结账前确认。",
    medication: "仅供比价。是否适用，请咨询药师。",
  },
  "zh-TW": {
    heading: "商家價格",
    checked: "查詢於",
    best: "同款已核實的最低商品價",
    priceUnknown: "打開商家查看價格",
    inStock: "查詢時有貨",
    outOfStock: "查詢時無現貨",
    retailer: "打開商家",
    checkout: "運費、稅費及折扣會影響總價，請在結帳前確認。",
    medication: "僅供比價。是否適用，請諮詢藥師。",
  },
} as const;

const RETAILERS = new Set([
  "amazon.com", "amazon.ca", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.co.jp", "amazon.com.au",
  "walmart.com", "walmart.ca", "target.com", "barnesandnoble.com", "bookshop.org", "rei.com",
  "lego.com", "ikea.com", "lakeshorelearning.com", "walgreens.com", "cvs.com", "iherb.com",
]);
const IMAGE_HOSTS = new Set([
  "m.media-amazon.com", "images-na.ssl-images-amazon.com", "images.amazon.com",
  "i5.walmartimages.com", "i5.walmartimages.ca", "target.scene7.com", "prodimage.images-bn.com",
  "images.booksense.com", "images-us.bookshop.org", "www.rei.com", "rei.com", "www.lego.com", "www.ikea.com",
  "www.lakeshorelearning.com", "www.walgreens.com", "pics.walgreens.com", "www.cvs.com",
  "s3.images-iherb.com", "cloudinary.images-iherb.com", "images.iherb.com",
]);

function validatedURL(value: unknown, image = false): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) return undefined;
    const host = parsed.hostname.replace(/^www\./, "");
    const officialBooksellerImage = parsed.hostname === "cdn.shopify.com"
      && parsed.pathname.startsWith("/s/files/1/0674/5433/7265/files/");
    const allowed = image ? IMAGE_HOSTS.has(parsed.hostname) || officialBooksellerImage : RETAILERS.has(host);
    const bookEdition = (host === "bookshop.org" || host === "barnesandnoble.com") && /^\?ean=[0-9]{13}$/.test(parsed.search);
    if (!allowed || (!image && parsed.search && !bookEdition)) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function readOffer(data: unknown): PriceOffer | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  const url = validatedURL(value.url);
  if (!url || typeof value.title !== "string" || !value.title.trim()
    || typeof value.retailer !== "string" || !value.retailer.trim()) return null;
  const validAmount = typeof value.price_amount === "string" && /^\d{1,7}(?:\.\d{1,4})?$/.test(value.price_amount);
  const availability = value.availability === "in_stock" || value.availability === "out_of_stock"
    ? value.availability : "unknown";
  return {
    title: value.title.trim().slice(0, 180),
    retailer: value.retailer.trim().slice(0, 40),
    url,
    image_url: validatedURL(value.image_url, true),
    price_amount: validAmount ? value.price_amount as string : undefined,
    currency: typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency) ? value.currency : undefined,
    availability,
  };
}

export function readProductComparison(transition: unknown, locale: keyof typeof PRODUCT_MEDIA_COPY) {
  if (!transition || typeof transition !== "object") return null;
  const data = transition as Record<string, unknown>;
  if (data.kind !== "product_comparison" || !Array.isArray(data.offers)) return null;
  const checked = typeof data.checked_at === "string" ? new Date(data.checked_at) : null;
  if (!checked || !Number.isFinite(checked.getTime())) return null;
  const offers = data.offers.slice(0, 6).map(readOffer).filter((row): row is PriceOffer => !!row);
  if (!offers.length) return null;
  const copy = PRODUCT_MEDIA_COPY[locale];
  const bestURL = validatedURL(data.best_price_url);
  const stamp = new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(checked);
  return {
    heading: copy.heading,
    checked: copy.checked + " " + stamp,
    notice: [copy.checkout, ...(data.is_medication === true ? [copy.medication] : [])],
    offers: offers.map((offer) => ({
      ...offer,
      price: offer.currency && offer.price_amount
        ? new Intl.NumberFormat(locale, { style: "currency", currency: offer.currency,
          currencyDisplay: "code", maximumFractionDigits: 4 }).format(Number(offer.price_amount))
        : copy.priceUnknown,
      best: offer.url === bestURL && offer.availability === "in_stock" && !!offer.price_amount && !!offer.currency ? copy.best : undefined,
      stock: offer.availability === "in_stock" ? copy.inStock
        : offer.availability === "out_of_stock" ? copy.outOfStock : undefined,
    })),
  };
}
