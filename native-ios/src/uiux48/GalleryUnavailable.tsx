import { Redirect } from "expo-router";
/** No fixture data, service simulation, or gallery UI is imported here. */
export default function GalleryUnavailable() { return <Redirect href="/welcome" />; }
