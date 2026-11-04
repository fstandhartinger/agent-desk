// Florian, 4 Nov 2026: "Ich will, dass volle, ungeschränkte Computersteuerung möglich ist." He supervises in real time, so no trigger gate, no step stop and no lock on other tools.
// DESK_COMPUTER_GUARDS=on brings the earlier rules back (the older tests run with it). The spend caps stay in both modes.
export const unrestricted = () => process.env.DESK_COMPUTER_GUARDS !== 'on';
export const UNRESTRICTED_RUN_MS = 60 * 60_000, UNRESTRICTED_ACTIONS = 1000;
