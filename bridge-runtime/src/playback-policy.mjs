/** Serializable policy. User intent is never changed by an automatic reason. */
export function resolvePlayback(effects = {}, environment = {}) {
  const reasons = [];
  if (effects.playing === false) reasons.push('user');
  if (environment.hidden === true && effects.pauseWhenHidden !== false) reasons.push('hidden');
  if (environment.occluded === true && effects.pauseWhenOccluded === true) reasons.push('occluded');
  if ((environment.onBattery ?? effects.onBattery) === true && effects.pauseOnBattery === true) reasons.push('battery');
  if (environment.inactive === true) reasons.push('inactive');
  return { userPlaying: effects.playing !== false, playing: reasons.length === 0, reasons };
}
