declare module 'three/addons/libs/utif.module.js' {
  export interface TiffImage {
    [tag: `t${number}`]: number[];
    width?: number;
    height?: number;
    data?: Uint8Array;
  }
  const UTIF: {
    decodeImage(buffer: ArrayBuffer, image: TiffImage): void;
  };
  export default UTIF;
}
