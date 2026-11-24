import type { ChatMediaViewerItem } from "./components/ChatMediaViewer";
import { externalSourceUrl } from "./externalContent";
import { readProductComparison } from "./replyMediaProducts";

type OpenInNuri = { page: "/daily-post" | "/daily-video"; id: string };
export type ChatMediaItem = ChatMediaViewerItem & {
  detail?: string;
  source?: string;
  badge?: string;
  stock?: string;
  inNuri?: OpenInNuri;
};

type ChatMediaMessage = {
  text: string;
  role: "ai" | "user";
  image_base64?: string | null;
  images_base64?: string[];
  transition?: unknown;
};

type Locale = "en" | "zh-CN" | "zh-TW";
const MAX_ITEMS = 10;
const SOURCE_URL = /\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s<>"']+)/g;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const CHILD = /\b(?:bab(?:y|ies)|infants?|toddlers?|child(?:ren)?|kids?|preschoolers?)\b|[宝寶]{2}|孩子|小孩|小朋友|幼[儿兒]|[婴嬰][儿兒]|[儿兒]童/u;
const YOUNG_AGE = /\b(?:[1-9]|[12]\d|3[0-6])[- ]months?[- ]old\b|\b[1-6][- ]years?[- ]old\b|\b(?:at|by) (?:[1-9]|[12]\d|3[0-6]) months?\b|(?:^|[^\d一二三四五六七八九十])(?:[1-6]|[一二三四五六])[岁歲]|(?:^|[^\d])(?:[1-9]|[12]\d|3[0-6])[个個]月/u;
const DEVELOPMENT = /\b(?:speech|language|vocabulary|communication|milestones?|developmental|talking|speaking|motor skills?|first (?:words?|steps?)|learn(?:ing)? to (?:talk|speak|walk)|child(?:hood)? development)\b|[语語][言音]|[说說][话話]|[讲講][话話]|[词詞][汇彙]|沟通|溝通|发育|發育|里程碑|开口|開口|学走|學走|早期[学學][习習]|(?:幼[儿兒]|[儿兒]童)(?:发展|發展)/u;
const ADULT_FINANCE_OR_AI = /\b(?:investments?|investing|forex|cryptocurrenc(?:y|ies)|bitcoin|etfs?|stock market|stock trading|short straddles?|covered calls?|options? (?:trading|premiums?|strateg(?:y|ies))|financial markets?|financial freedom|passive income|retirement planning|roth ira|401\(?k\)?|artificial intelligence|large language models?|llms?|ai|gpt|openai|grok[- ]?\d+(?:\.\d+)*|chatgpt(?:[- ]?\d(?:\.\d+)?)?|generative ai|machine learning|deep learning)\b|股市|股票|投资|投資|理财|理財|外汇|外匯|比特[币幣]|加密[货貨][币幣]|期[货貨]|期[权權]|[权權]利金|[证證]券|人工智能|人工智慧|大(?:型)?[语語]言模型|推理模型|模型(?:基[准準]|跑分)|生成式\s*ai|机器学习|機器學習|深度学习|深度學習/u;
const CHILD_CARE = /\b(?:sleep|feeding|breastfeeding|weaning|nutrition|play|playtime|games?|tantrums?|potty|reading|school|education|literacy|college|savings?|allowance|monitor|safety)\b|睡眠|[喂餵][养養]|副食品|母乳|育[儿兒]|[亲親]子|教育|[识識]字|[学學][习習]|童[书書]|[储儲]蓄|零用[钱錢]|安全|[游遊][戏戲]|[积積]木|玩具/u;

function topicText(value: unknown, limit: number) {
  return typeof value === "string" ? value.slice(0, limit).normalize("NFKC").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim() : "";
}

function childDevelopmentContext(value: string) {
  return (CHILD.test(value) || YOUNG_AGE.test(value)) && DEVELOPMENT.test(value);
}

/** Legacy chat_media rows have URLs but no reliable relevance evidence. This
 * is a conservative rendering backstop, not a general recommendation ranker:
 * only a clear adult-finance/AI title under a child-development reply is hidden.
 * Related parenting uses of AI, children's money education and unknown titles
 * remain the backend curator's decision. The production caller is Alpha iOS. */
function unrelatedLegacyChildVideo(title: unknown) {
  const knownTitle = topicText(title, 400);
  if (!ADULT_FINANCE_OR_AI.test(knownTitle)) return false;
  const childTitle = CHILD.test(knownTitle) || YOUNG_AGE.test(knownTitle);
  const parentingOverlap = childDevelopmentContext(knownTitle)
    || /\b(?:parenting|parenthood)\b|育[儿兒]|[亲親]子/u.test(knownTitle)
    || /\bspeech (?:therapy|therapists?|delays?)\b|[语語]言治[疗療]|言[语語]治[疗療]/u.test(knownTitle)
    || (childTitle && CHILD_CARE.test(knownTitle))
    || /\b(?:for|teaching) (?:kids|children|toddlers|babies)\b/u.test(knownTitle);
  return !parentingOverlap;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function clip(value: unknown, length = 160) {
  return typeof value === "string" ? value.trim().slice(0, length) : "";
}

function httpsURL(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  const source = externalSourceUrl(value);
  if (!source) return undefined;
  const url = new URL(source);
  return /\.(?:example|invalid|test|onion)$/.test(url.hostname) ? undefined : url;
}

function photo(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value.length <= 3_250_000 && /^data:image\/(jpeg|png|webp|gif);base64,/i.test(value)
    ? value : httpsURL(value)?.href;
}

function youtubeId(url?: URL) {
  if (!url) return undefined;
  const host = url.hostname.replace(/^(?:www|m)\./, "");
  const [, section, slug] = url.pathname.split("/");
  const id = host === "youtu.be" ? section :
    host === "youtube.com" || host === "youtube-nocookie.com"
      ? url.searchParams.get("v") || (/^(?:shorts|embed|live)$/.test(section) ? slug : "") : "";
  return id && VIDEO_ID.test(id) ? id : undefined;
}

function youtubeURL(id: string) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function youtubeThumb(id: string) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function mediaLink(raw: unknown, title: unknown, type?: unknown, image?: unknown, providedYoutubeId?: unknown): ChatMediaItem | null {
  const url = httpsURL(raw);
  if (!url) return null;
  const actualYoutubeId = youtubeId(url);
  if (providedYoutubeId != null && providedYoutubeId !== actualYoutubeId) return null;
  const kind = actualYoutubeId || type === "video" || /\.(?:mp4|mov|m4v|m3u8)$/i.test(url.pathname) ? "video" :
    type === "image" || /\.(?:jpe?g|png|gif|webp|avif|heic)$/i.test(url.pathname) ? "image" : "article";
  const destination = actualYoutubeId ? youtubeURL(actualYoutubeId) : url.href;
  return {
    kind,
    id: destination,
    url: destination,
    title: clip(title) || url.hostname.replace(/^www\./, ""),
    source: actualYoutubeId ? "YouTube" : url.hostname.replace(/^www\./, ""),
    thumbnail: (kind === "image" ? photo(image) || destination : photo(image)) ||
      (actualYoutubeId ? youtubeThumb(actualYoutubeId) : undefined),
  };
}

export function readChatMedia(msg: ChatMediaMessage, locale: Locale) {
  const items: ChatMediaItem[] = [];
  const seen = new Set<string>();
  const hiddenLegacyVideos = new Set<string>();
  const add = (item: ChatMediaItem | null) => {
    if (item && !seen.has(item.url) && items.length < MAX_ITEMS) {
      seen.add(item.url);
      items.push(item);
    }
  };
  for (const uri of (msg.images_base64?.length ? msg.images_base64 : [msg.image_base64]).slice(0, MAX_ITEMS)) {
    const url = photo(uri);
    if (url) add({ id: `photo-${items.length}`, kind: "image", url, thumbnail: url,
      title: locale === "en" ? `Photo ${items.length + 1}` : `照片 ${items.length + 1}` });
  }

  const data = record(msg.transition);
  const product = readProductComparison(data, locale);
  for (const offer of product?.offers ?? []) {
    add({ id: offer.url, kind: "product", url: offer.url, title: offer.title, thumbnail: offer.image_url,
      source: offer.retailer, detail: offer.price, badge: offer.best, stock: offer.stock });
  }
  if (data?.kind === "chat_media" && Array.isArray(data.items)) {
    const childDevelopmentReply = msg.role === "ai" && childDevelopmentContext(topicText(msg.text, 12_000));
    for (const row of data.items.slice(0, MAX_ITEMS)) {
      const source = record(row);
      if (source?.type === "video" || source?.type === "article" || source?.type === "image") {
        const item = mediaLink(source.url, source.title, source.type, source.thumbnail_url, source.video_id);
        if (childDevelopmentReply && item?.kind === "video" && unrelatedLegacyChildVideo(source.title)) {
          hiddenLegacyVideos.add(item.url);
          continue;
        }
        add(item);
      }
    }
  }
  if (data?.kind === "card_opened") {
    const post = record(data.post), video = record(data.video);
    if (post && /^[A-Za-z0-9_-]{1,128}$/.test(clip(post.id))) {
      const id = clip(post.id);
      add({ id: `daily-post-${id}`, kind: "article", url: `nuri:daily-post/${id}`,
        title: clip(post.headline) || clip(data.title), source: clip(post.source_label, 55),
        thumbnail: photo(post.thumbnail_url) || photo(post.image_url), inNuri: { page: "/daily-post", id } });
    }
    if (video && /^[A-Za-z0-9_-]{1,128}$/.test(clip(video.id))) {
      const id = clip(video.id), thumbnail = photo(video.thumbnail_url);
      const thumbURL = httpsURL(thumbnail);
      const thumbId = thumbURL?.hostname === "i.ytimg.com" ? /^\/vi(?:_webp)?\/([\w-]{11})\//.exec(thumbURL.pathname)?.[1] : undefined;
      const explicitId = typeof video.video_id === "string" && VIDEO_ID.test(video.video_id) ? video.video_id : undefined;
      const youtube = youtubeId(httpsURL(video.url)) || explicitId || thumbId;
      add({ id: `daily-video-${id}`, kind: "video", url: youtube ? youtubeURL(youtube) : `nuri:daily-video/${id}`,
        title: clip(video.title) || clip(data.title), source: clip(video.channel, 55) || "YouTube",
        thumbnail: thumbnail || (youtube ? youtubeThumb(youtube) : undefined),
        ...(youtube ? {} : { inNuri: { page: "/daily-video", id } }) });
    }
  }

  const text = msg.role === "ai" && msg.text.includes("https://")
    ? msg.text.replace(SOURCE_URL, (match: string, label: string | undefined, markdown: string | undefined, plain: string | undefined) => {
      const raw = (markdown || plain || "");
      const trimmed = plain ? raw.replace(/[.,!?;:)\]。，、；！？）】]+$/, "") : raw;
      const link = mediaLink(trimmed, label);
      if (!link) return match;
      // Do not turn a just-hidden structured video into another carousel card
      // via the same URL in the assistant text. Keep that original text intact.
      if (hiddenLegacyVideos.has(link.url) && !seen.has(link.url)) return match;
      add(link);
      if (!seen.has(link.url)) return match;
      return label || raw.slice(trimmed.length);
    }).replace(/[ \t]+\n/g, "\n").trim() : msg.text;
  return { items, text, comparison: product && { heading: product.heading, checked: product.checked, notice: product.notice } };
}
