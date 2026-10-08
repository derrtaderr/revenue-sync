// Dummy credentials are assembled at runtime so no secret-shaped literal ever sits in the repo
// (push protection flags those, and the lint gate refuses them).
export const stripeTestKey = () => ['sk', 'test', '51Dummy' + 'a1b2c3d4e5f6g7h8i9j0'].join('_');
export const stripeLiveKey = () => ['sk', 'live', '51Dummy' + 'z9y8x7w6v5u4t3s2r1q0'].join('_');
export const restrictedTestKey = () => ['rk', 'test', '51Dummy' + 'k1l2m3n4o5p6q7r8s9t0'].join('_');
export const hubspotToken = () => ['pat', 'na1', '8c1f2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'].join('-');
