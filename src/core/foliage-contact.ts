import type { FoliageModel } from './types';

export type FoliageContactPreset = 'grass' | 'plant' | 'woody' | 'rigid';
/** Artist starting points. Exact branch/wood separation can use an authored mask. */
export function foliageContactPreset(
  preset: FoliageContactPreset,
): Pick<FoliageModel, 'crush' | 'interaction' | 'flexibility'> {
  const rigid = preset === 'rigid',
    woody = preset === 'woody',
    grass = preset === 'grass';
  return {
    crush: rigid ? 0 : grass ? 1 : woody ? 0.4 : 0.65,
    interaction: {
      enabled: !rigid,
      radius: 2,
      recovery: grass ? 3 : woody ? 0.7 : 1.5,
    },
    flexibility: {
      source: woody ? 'leaves' : 'height',
      start: woody ? 0 : 0.02,
      end: 1,
      exponent: woody ? 1 : grass ? 1 : 1.5,
    },
  };
}
