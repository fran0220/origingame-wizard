import { og } from '@origingame/engine'

// Tile Swap: swap two neighbouring tiles to line up three of a colour.
export default og.game({
  name: 'Tile Swap',
  setup(world) {
    world.spawnScene('scenes/main.ogt')
  },
})
