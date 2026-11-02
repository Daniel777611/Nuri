declare module "nuri-ux49-flow-preview" {
  import type { ComponentType } from "react";
  export const FLOW_PREVIEW_ENABLED: boolean;
  const FlowPreview: ComponentType<{entry:"community"|"notifications"}>;
  export default FlowPreview;
}
