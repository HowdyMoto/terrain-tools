export const textureAccept = '.png,.jpg,.jpeg,.webp,.tif,.tiff,.tga';
export const textureFormats = 'PNG, JPG, WebP, TIFF or TGA';
export const isTextureFile = (name: string) =>
  /\.(png|jpe?g|webp|tiff?|tga)$/i.test(name);
export const needsTextureConversion = (name: string) =>
  /\.(tiff?|tga)$/i.test(name);
