import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from '../../engine/index.js';

// Minimal geometry accumulator for the town: flat-shaded quads, triangles and boxes with
//   uv    face-local metres (u along the face, v up), so the procedural materials have a constant
//         texel density
//   tint  vec3 colour (plaster colour, stone tone, trim paint)
//   vdata vec4 material parameters (per material, see TownMaterials)
export class MeshKit {

	constructor() {

		this.pos = [];
		this.nrm = [];
		this.uv = [];
		this.tint = [];
		this.data = [];
		this.idx = [];
		this.count = 0;
		this.color = [ 1, 1, 1 ];
		this.vdata = [ 0, 0, 0, 0 ];

	}

	vertex( p, n, u, v ) {

		this.pos.push( p[ 0 ], p[ 1 ], p[ 2 ] );
		this.nrm.push( n[ 0 ], n[ 1 ], n[ 2 ] );
		this.uv.push( u, v );
		this.tint.push( this.color[ 0 ], this.color[ 1 ], this.color[ 2 ] );
		this.data.push( this.vdata[ 0 ], this.vdata[ 1 ], this.vdata[ 2 ], this.vdata[ 3 ] );
		return this.count ++;

	}

	// planar quad a, b, c, d (counter-clockwise seen from the front), normal from the winding
	// unless given; uvs: [ [u, v] x 4 ] or computed from the edge lengths
	quad( a, b, c, d, uvs = null, n = null ) {

		n = n || faceNormal( a, b, d );
		if ( ! uvs ) {

			const w = dist( a, b ), h = dist( a, d );
			uvs = [ [ 0, 0 ], [ w, 0 ], [ w, h ], [ 0, h ] ];

		}

		const i0 = this.vertex( a, n, uvs[ 0 ][ 0 ], uvs[ 0 ][ 1 ] );
		const i1 = this.vertex( b, n, uvs[ 1 ][ 0 ], uvs[ 1 ][ 1 ] );
		const i2 = this.vertex( c, n, uvs[ 2 ][ 0 ], uvs[ 2 ][ 1 ] );
		const i3 = this.vertex( d, n, uvs[ 3 ][ 0 ], uvs[ 3 ][ 1 ] );
		this.idx.push( i0, i1, i2, i0, i2, i3 );

	}

	// quad a, b, c, d (in order round the edge, either winding) made to face `want` (a direction);
	// uvs as in quad(): they follow the vertices
	quadFacing( a, b, c, d, want, uvs = null ) {

		// from the diagonals: the same as a side's for a flat quad, and still right when a side has
		// shrunk to a point (a triangle, as at a mitred wall corner)
		const n = faceNormal( [ 0, 0, 0 ], [ c[ 0 ] - a[ 0 ], c[ 1 ] - a[ 1 ], c[ 2 ] - a[ 2 ] ], [ d[ 0 ] - b[ 0 ], d[ 1 ] - b[ 1 ], d[ 2 ] - b[ 2 ] ] );
		if ( n[ 0 ] * want[ 0 ] + n[ 1 ] * want[ 1 ] + n[ 2 ] * want[ 2 ] >= 0 ) return this.quad( a, b, c, d, uvs, n );
		if ( ! uvs ) {

			const w = dist( a, b ), h = dist( a, d );
			uvs = [ [ 0, 0 ], [ w, 0 ], [ w, h ], [ 0, h ] ];

		}

		this.quad( a, d, c, b, [ uvs[ 0 ], uvs[ 3 ], uvs[ 2 ], uvs[ 1 ] ], [ - n[ 0 ], - n[ 1 ], - n[ 2 ] ] );

	}

	tri( a, b, c, uvs, n = null ) {

		n = n || faceNormal( a, b, c );
		const i0 = this.vertex( a, n, uvs[ 0 ][ 0 ], uvs[ 0 ][ 1 ] );
		const i1 = this.vertex( b, n, uvs[ 1 ][ 0 ], uvs[ 1 ][ 1 ] );
		const i2 = this.vertex( c, n, uvs[ 2 ][ 0 ], uvs[ 2 ][ 1 ] );
		this.idx.push( i0, i1, i2 );

	}

	// vertical wall quad from ground point p0 to p1 (x, z), bottom y0* / top y1*; faces to the right
	// of p0 -> p1 on a map with x right and z down (normal ( -dz, 0, dx )). u starts at u0.
	wall( p0, p1, y00, y01, y10, y11, u0 = 0 ) {

		const L = Math.hypot( p1[ 0 ] - p0[ 0 ], p1[ 1 ] - p0[ 1 ] );
		const a = [ p0[ 0 ], y00, p0[ 1 ] ], b = [ p1[ 0 ], y01, p1[ 1 ] ], c = [ p1[ 0 ], y11, p1[ 1 ] ], d = [ p0[ 0 ], y10, p0[ 1 ] ];
		const dx = ( p1[ 0 ] - p0[ 0 ] ) / ( L || 1 ), dz = ( p1[ 1 ] - p0[ 1 ] ) / ( L || 1 );
		this.quad( a, b, c, d, [ [ u0, y00 ], [ u0 + L, y01 ], [ u0 + L, y11 ], [ u0, y10 ] ], [ - dz, 0, dx ] );

	}

	// oriented box: centre (x, y, z), size (sx along the yaw direction, sy, sz), yaw (radians, about +y);
	// faces: all six unless `skip` names some of 'top', 'bottom', '+x', '-x', '+z', '-z'
	box( cx, cy, cz, sx, sy, sz, yaw = 0, skip = '' ) {

		const c = Math.cos( yaw ), s = Math.sin( yaw );
		// local x -> world ( c, -s ), local z -> world ( s, c )
		const P = ( lx, ly, lz ) => [ cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c ];
		const hx = sx / 2, hy = sy / 2, hz = sz / 2;
		const v = [
			P( - hx, - hy, - hz ), P( hx, - hy, - hz ), P( hx, hy, - hz ), P( - hx, hy, - hz ),
			P( - hx, - hy, hz ), P( hx, - hy, hz ), P( hx, hy, hz ), P( - hx, hy, hz ),
		];
		const y0 = cy - hy;
		const face = ( name, a, b, cc, d, w, h, u0 = 0, v0 = 0 ) => {

			if ( skip.includes( name ) ) return;
			this.quad( v[ a ], v[ b ], v[ cc ], v[ d ], [ [ u0, v0 ], [ u0 + w, v0 ], [ u0 + w, v0 + h ], [ u0, v0 + h ] ] );

		};

		face( '+z', 4, 5, 6, 7, sx, sy, 0, y0 );
		face( '-z', 1, 0, 3, 2, sx, sy, 0, y0 );
		face( '+x', 5, 1, 2, 6, sz, sy, 0, y0 );
		face( '-x', 0, 4, 7, 3, sz, sy, 0, y0 );
		face( 'top', 7, 6, 2, 3, sx, sz );
		face( 'bottom', 0, 1, 5, 4, sx, sz );

	}

	get empty() {

		return this.count === 0;

	}

	build() {

		const g = new BufferGeometry();
		g.setAttribute( 'position', new Float32BufferAttribute( this.pos, 3 ) );
		g.setAttribute( 'normal', new Float32BufferAttribute( this.nrm, 3 ) );
		g.setAttribute( 'uv', new Float32BufferAttribute( this.uv, 2 ) );
		g.setAttribute( 'tint', new Float32BufferAttribute( this.tint, 3 ) );
		g.setAttribute( 'vdata', new Float32BufferAttribute( this.data, 4 ) );
		g.setIndex( new Uint32BufferAttribute( this.idx, 1 ) );
		g.computeBoundingBox();
		g.computeBoundingSphere();
		return g;

	}

}

export function dist( a, b ) {

	return Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ], b[ 2 ] - a[ 2 ] );

}

export function faceNormal( a, b, c ) {

	const ux = b[ 0 ] - a[ 0 ], uy = b[ 1 ] - a[ 1 ], uz = b[ 2 ] - a[ 2 ];
	const vx = c[ 0 ] - a[ 0 ], vy = c[ 1 ] - a[ 1 ], vz = c[ 2 ] - a[ 2 ];
	const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
	const l = Math.hypot( nx, ny, nz ) || 1;
	return [ nx / l, ny / l, nz / l ];

}
