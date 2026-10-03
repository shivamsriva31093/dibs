import type { Agent } from "../../../src/types";

// One pencil colour per agent, in the order the agents were created.
// Ordered so that the first five are far apart in hue, and none of those is close to the
// signal colour that marks what needs a person.
const PENCILS = ["#2356c7", "#b07a0a", "#3f8a2c", "#7446c9", "#0e7c86", "#a8432f", "#9a3a7d", "#4f5b66"];

export type StakeOf = (agentName: string) => string;

export function stakes(agents: Agent[]): StakeOf {
  const byName = new Map(agents.map((agent, index) => [agent.name, PENCILS[index % PENCILS.length]!]));
  return (agentName) => byName.get(agentName) ?? "#4f5b66";
}
