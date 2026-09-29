import * as THREE from 'three';

/**
 * Desktop ANGLE (Edge and Chrome on Windows, the D3D11 backend) does not match
 * native GL, Metal or SwiftShader in two places this scene depends on.
 *
 * `normalize(vec3(0))` is NaN on D3D11 and a zero vector on the others. The
 * stadium's end walls used to be double-wound, so their vertex normals cancelled
 * to zero. Those NaNs are multiplied by the shadow normal bias and added to the
 * world position, and a NaN fragment on D3D11 can also black out a whole
 * render-target tile. That is the flickering black box over the bowl.
 *
 * RGBA depth packing multiplies by 256^3. That constant overflows fp16 (max
 * 65504) and the matching unpack factor 1/16777216 flushes to zero when the
 * fragment shader runs at mediump, which ANGLE has done. The shadow map then
 * comes back solid and the lit slice of the city is a black slab. The pack and
 * the depth varying are forced to highp, and 256^3 is written as a highp
 * literal so it is not constant-folded in mediump.
 */

function replaceChunk(name, from, to) {
  const source = THREE.ShaderChunk[name];
  if (!source.includes(from)) {
    throw new Error(`gl-robust: ${name} no longer contains the expected shader text`);
  }
  THREE.ShaderChunk[name] = source.replace(from, to);
}

replaceChunk(
  'common',
  'vec3 transformDirection( in vec3 dir, in mat4 matrix ) {\n\treturn normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );\n}',
  `vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	vec3 t = ( matrix * vec4( dir, 0.0 ) ).xyz;
	float l2 = dot( t, t );
	return l2 > 1e-12 ? t * inversesqrt( l2 ) : vec3( 0.0, 1.0, 0.0 );
}`,
);

replaceChunk(
  'common',
  'vec3 inverseTransformDirection( in vec3 dir, in mat4 matrix ) {\n\treturn normalize( ( vec4( dir, 0.0 ) * matrix ).xyz );\n}',
  `vec3 inverseTransformDirection( in vec3 dir, in mat4 matrix ) {
	vec3 t = ( vec4( dir, 0.0 ) * matrix ).xyz;
	float l2 = dot( t, t );
	// ANGLE/D3D11 returns NaN for normalize(0); that NaN becomes the shadow coordinate.
	return l2 > 1e-12 ? t * inversesqrt( l2 ) : vec3( 0.0, 1.0, 0.0 );
}`,
);

replaceChunk(
  'normal_fragment_begin',
  '\tvec3 normal = normalize( vNormal );',
  `\tvec3 normal = vNormal;
	float normalLen2 = dot( normal, normal );
	normal = normalLen2 > 1e-8 ? normal * inversesqrt( normalLen2 ) : vec3( 0.0, 0.0, 1.0 );`,
);

replaceChunk(
  'normal_fragment_begin',
  '\tvec3 normal = normalize( cross( fdx, fdy ) );',
  `\tvec3 normal = cross( fdx, fdy );
	float flatLen2 = dot( normal, normal );
	normal = flatLen2 > 1e-8 ? normal * inversesqrt( flatLen2 ) : vec3( 0.0, 0.0, 1.0 );`,
);

replaceChunk(
  'packing',
  'vec4 packDepthToRGBA( const in float v ) {\n\tif( v <= 0.0 )\n\t\treturn vec4( 0., 0., 0., 0. );\n\tif( v >= 1.0 )\n\t\treturn vec4( 1., 1., 1., 1. );\n\tfloat vuf;\n\tfloat af = modf( v * PackFactors.a, vuf );\n\tfloat bf = modf( vuf * ShiftRight8, vuf );\n\tfloat gf = modf( vuf * ShiftRight8, vuf );\n\treturn vec4( vuf * Inv255, gf * PackUpscale, bf * PackUpscale, af );\n}',
  `vec4 packDepthToRGBA( const in float v ) {
	highp float vv = v;
	if( vv <= 0.0 )
		return vec4( 0., 0., 0., 0. );
	if( vv >= 1.0 )
		return vec4( 1., 1., 1., 1. );
	highp float vuf;
	highp float af = modf( vv * 16777216.0, vuf );
	highp float bf = modf( vuf * 0.00390625, vuf );
	highp float gf = modf( vuf * 0.00390625, vuf );
	return vec4( vuf * 0.00392156862, gf * 1.00392156862, bf * 1.00392156862, af );
}`,
);

replaceChunk(
  'packing',
  'float unpackRGBAToDepth( const in vec4 v ) {\n\treturn dot( v, UnpackFactors4 );\n}',
  `float unpackRGBAToDepth( const in vec4 v ) {
	highp vec4 c = v;
	const highp float inv = 0.99609375;
	return c.r * inv + c.g * (inv * 0.00390625) + c.b * (inv * 0.0000152587890625) + c.a * (1.0 / 16777216.0);
}`,
);

const depthLib = THREE.ShaderLib.depth;
for (const shader of [depthLib.vertexShader, depthLib.fragmentShader]) {
  if (!shader.includes('varying vec2 vHighPrecisionZW;')) {
    throw new Error('gl-robust: depth shader no longer declares vHighPrecisionZW');
  }
}
depthLib.vertexShader = depthLib.vertexShader.replace(
  'varying vec2 vHighPrecisionZW;',
  'varying highp vec2 vHighPrecisionZW;',
);
depthLib.fragmentShader = depthLib.fragmentShader.replace(
  'varying vec2 vHighPrecisionZW;',
  'varying highp vec2 vHighPrecisionZW;',
);
