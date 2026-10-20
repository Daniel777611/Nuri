/** Only known internal resource pages can be reloaded from a status screen.
 * Never carry an external URL or arbitrary navigation destination here. */
export function contentReturnTarget(kind: unknown, id: unknown) {
 const pathname=kind==="video"?"/daily-video":"/daily-post";
 const safeId=typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id)?id:undefined;
 return {pathname,params:safeId?{id:safeId}:{}} as const;
}
