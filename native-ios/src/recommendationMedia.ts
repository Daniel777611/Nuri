import {externalSourceUrl} from "./externalContent";

/** The current feed derives this same public cover from its validated video ID.
 * Never use a different video's thumbnail or an arbitrary response URL. */
export function youtubeVideoThumbnail(videoId:unknown):string|null{
 return typeof videoId==="string"&&/^[A-Za-z0-9_-]{11}$/.test(videoId)
  ?`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`:null;
}

/** Optional feed-supplied preview only, not a client-side scrape/OG service.
 * The current generator may omit these fields. Reject credentials and local
 * targets, and restrict supplied thumbnails to the social image CDNs. */
export function socialPostThumbnail(value:unknown,sourceUrl:unknown):string|null{
 if(!externalSourceUrl(sourceUrl))return null;
 const safe=externalSourceUrl(value);
 if(!safe||safe.length>4096)return null;
 const url=new URL(safe),host=url.hostname.toLowerCase();
 if(!["fbcdn.net","cdninstagram.com"].some(domain=>host===domain||host.endsWith(`.${domain}`)))return null;
 if(!/\.(?:jpe?g|png|webp|avif|gif)$/i.test(url.pathname))return null;
 // Social avatars and page furniture must not be labelled as post artwork.
 if(/avatar|profile[\s_-]*(?:picture|photo|image)|favicon|\blogo\b|\bicon\b/i.test(url.pathname)||/\/t\d+(?:\.\d+)*-(?:1|19)\//i.test(url.pathname))return null;
 return safe;
}
