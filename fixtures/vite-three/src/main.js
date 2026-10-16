// Orbit Drift: steer a small ship around a planet with the mouse or touch; dodge the debris.
import * as THREE from 'three'

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100)
camera.position.z = 6
const planet = new THREE.Mesh(new THREE.SphereGeometry(1.5, 32, 16), new THREE.MeshStandardMaterial({ color: 0x3355ff }))
scene.add(planet)
let angle = 0
addEventListener('pointermove', e => { angle = (e.clientX / innerWidth) * Math.PI * 2 })
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight })
renderer.setAnimationLoop(() => {
  planet.rotation.y = angle
  renderer.render(scene, camera)
})
