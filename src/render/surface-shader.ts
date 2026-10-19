/** Triplanar texture frames are right-handed on positive and negative axes. */
export const surfaceDeclarations = `
precision highp sampler2DArray;
precision highp int;
varying vec4 vWeights; varying vec3 vTerrain; varying vec3 vTerrainNormal;
uniform mat3 normalMatrix;
uniform sampler2DArray terrainAlbedo; uniform sampler2DArray terrainNormal; uniform sampler2DArray terrainOrm; uniform sampler2DArray terrainHeight;
uniform vec4 layerVariation; uniform vec4 layerIndices;
uniform vec3 layerColors[4]; uniform vec4 layerRoughness; uniform vec4 layerMetalness; uniform vec4 layerScale; uniform vec4 layerBlend; uniform vec4 layerNormalStrength; uniform vec4 layerNormalY;
struct TerrainProjection { vec2 uv; vec2 dx; vec2 dy; };
TerrainProjection terrainFrames[3];
vec3 projectionSigns(vec3 n){return vec3(n.x<0.0?-1.0:1.0,n.y<0.0?-1.0:1.0,n.z<0.0?-1.0:1.0);}
vec3 projectionWeights(vec3 n){vec3 w=pow(abs(n),vec3(4.0));return w/max(dot(w,vec3(1.0)),0.00001);}
// Three overlapping patches share offsets and weights across every material map.
// Explicit derivatives keep hash discontinuities out of mip selection.
vec2 terrainTileOffset(vec2 cell){
  uvec2 key=uvec2(ivec2(cell));
  uint h=key.x*1664525u+key.y*1013904223u+374761393u;
  h=(h^(h>>16u))*2246822519u;h=(h^(h>>13u))*3266489917u;h^=h>>16u;
  uint k=(h^668265263u)*2246822519u;k=(k^(k>>13u))*3266489917u;k^=k>>16u;
  return vec2(float(h&65535u),float(k&65535u))/65536.0;
}
vec4 terrainMapSample(sampler2DArray tex,int axis,float layer,float variation){
  vec2 uv=terrainFrames[axis].uv,dx=terrainFrames[axis].dx,dy=terrainFrames[axis].dy;
  if(variation<0.5)return textureGrad(tex,vec3(uv,layer),dx,dy);
  vec2 grid=vec2(uv.x-uv.y*0.57735026919,uv.y*1.15470053838)*0.5;
  vec2 cell=floor(grid),f=fract(grid),a,b,c;vec3 w;
  if(f.x+f.y<=1.0){
    a=cell;b=cell+vec2(1.0,0.0);c=cell+vec2(0.0,1.0);
    w=vec3(1.0-f.x-f.y,f.x,f.y);
  }else{
    a=cell+vec2(1.0);b=cell+vec2(0.0,1.0);c=cell+vec2(1.0,0.0);
    w=vec3(f.x+f.y-1.0,1.0-f.x,1.0-f.y);
  }
  w*=w;w*=w;w/=max(dot(w,vec3(1.0)),0.00001);
  return textureGrad(tex,vec3(uv+terrainTileOffset(a),layer),dx,dy)*w.x+
         textureGrad(tex,vec3(uv+terrainTileOffset(b),layer),dx,dy)*w.y+
         textureGrad(tex,vec3(uv+terrainTileOffset(c),layer),dx,dy)*w.z;
}
vec4 triSample(sampler2DArray tex,vec3 n,float layer,float variation){
  vec3 w=projectionWeights(n);
  return terrainMapSample(tex,0,layer,variation)*w.x+
         terrainMapSample(tex,1,layer,variation)*w.y+
         terrainMapSample(tex,2,layer,variation)*w.z;
}
vec3 triNormal(vec3 n,float layer,float strength,float normalY,float variation){
  if(strength<=0.0)return n;
  vec3 s=projectionSigns(n),w=projectionWeights(n);
  vec3 x=terrainMapSample(terrainNormal,0,layer,variation).xyz*2.0-1.0;
  vec3 y=terrainMapSample(terrainNormal,1,layer,variation).xyz*2.0-1.0;
  vec3 z=terrainMapSample(terrainNormal,2,layer,variation).xyz*2.0-1.0;
  vec2 normalScale=vec2(strength,strength*normalY);
  x.xy*=normalScale;y.xy*=normalScale;z.xy*=normalScale;
  x=normalize(x);y=normalize(y);z=normalize(z);
  vec3 nx=vec3(x.z*n.x,x.y+n.y,-x.x*s.x+n.z);
  vec3 ny=vec3(y.x+n.x,y.z*n.y,-y.y*s.y+n.z);
  vec3 nz=vec3(z.x*s.z+n.x,z.y+n.y,z.z*n.z);
  return normalize(nx*w.x+ny*w.y+nz*w.z);
}
`;
export const surfaceEvaluation = `
  vec3 terrainN=normalize(vTerrainNormal);
  #ifdef FLAT_SHADED
    terrainN=normalize(cross(dFdx(vTerrain),dFdy(vTerrain)));
    if(dot(terrainN,vTerrainNormal)<0.0)terrainN=-terrainN;
  #endif
  vec3 terrainDx=dFdx(vTerrain),terrainDy=dFdy(vTerrain);
  vec4 th;vec4 tc[4];vec4 orm[4];vec3 tn[4];
  for(int i=0;i<4;i++){
    // Derivatives must be evaluated before the varying coverage branch, including
    // at paint boundaries. Every map shares these explicit projection gradients.
    float scale=max(layerScale[i],0.01);
    vec3 p=vTerrain/scale,s=projectionSigns(terrainN),dx=terrainDx/scale,dy=terrainDy/scale;
    terrainFrames[0].uv=vec2(-s.x*p.z,p.y);
    terrainFrames[1].uv=vec2(p.x,-s.y*p.z);
    terrainFrames[2].uv=vec2(s.z*p.x,p.y);
    terrainFrames[0].dx=vec2(-s.x*dx.z,dx.y);terrainFrames[0].dy=vec2(-s.x*dy.z,dy.y);
    terrainFrames[1].dx=vec2(dx.x,-s.y*dx.z);terrainFrames[1].dy=vec2(dy.x,-s.y*dy.z);
    terrainFrames[2].dx=vec2(s.z*dx.x,dx.y);terrainFrames[2].dy=vec2(s.z*dy.x,dy.y);
    // Zero-coverage layers cannot contribute to the final height blend. Most
    // forest-floor fragments use one layer; avoid sampling all sixteen maps.
    if(vWeights[i]<0.00001){tc[i]=vec4(0.0);orm[i]=vec4(0.0);th[i]=0.0;tn[i]=terrainN;continue;}
    tc[i]=triSample(terrainAlbedo,terrainN,layerIndices[i],layerVariation[i]);orm[i]=triSample(terrainOrm,terrainN,layerIndices[i],layerVariation[i]);
    th[i]=triSample(terrainHeight,terrainN,layerIndices[i],layerVariation[i]).r*layerBlend[i];tn[i]=triNormal(terrainN,layerIndices[i],layerNormalStrength[i],layerNormalY[i],layerVariation[i]);
  }
  vec4 h=vWeights+th;
  // A layer with no coverage must never suppress an active layer.
  for(int i=0;i<4;i++)if(vWeights[i]<0.00001)h[i]=-10000.0;
  float peak=max(max(h.x,h.y),max(h.z,h.w));
  vec4 blend=max(h-peak+0.22,0.0)*vWeights;
  blend/=max(dot(blend,vec4(1.0)),0.00001);
  vec3 surface=vec3(0.0),surfaceNormal=vec3(0.0);float surfaceRoughness=0.0,surfaceMetalness=0.0,surfaceAo=0.0;
  for(int i=0;i<4;i++){
    surface+=tc[i].rgb*layerColors[i]*blend[i];surfaceNormal+=tn[i]*blend[i];
    surfaceRoughness+=orm[i].g*layerRoughness[i]*blend[i];surfaceMetalness+=orm[i].b*layerMetalness[i]*blend[i];surfaceAo+=orm[i].r*blend[i];
  }
  diffuseColor.rgb*=surface;
`;
