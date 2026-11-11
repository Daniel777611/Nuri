import { Redirect } from "expo-router";
/** This branch's connected Community is for the existing Alpha identity only. */
export default function CommunityUnavailable() { return <Redirect href="/(tabs)" />; }
