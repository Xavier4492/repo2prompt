#!/usr/bin/env node

import { main } from './index'

main().catch((err: any) => {
  console.error('Fatal error:')
  console.error(err)
  process.exit(1)
})
