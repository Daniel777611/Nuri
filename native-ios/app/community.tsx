import CommunityFinal from "nuri-live-community";
import { useAccountScope } from "@/src/useAccountState";

/** Community on the live /api/community/v1 API. A session boundary remounts
 * it, so one account's drafts and loaded data never reach the next. */
export default function Community() {
  const { generation } = useAccountScope();
  return <CommunityFinal key={generation} />;
}
