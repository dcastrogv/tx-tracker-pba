import type {
  API,
  FinalizedEvent,
  IncomingEvent,
  NewBlockEvent,
  NewTransactionEvent,
  OutputAPI,
  Settled,
} from "../types"

interface Block {
  blockHash: string
  parent: string
  children: string[]
}

export default function officialSolution(api: API, outputApi: OutputAPI) {
  // The key is the transaction, the value is the blocks in which
  // this transaction is settled.
  const ongoingTxs = new Map<string, Map<string, Settled>>()
  const blocks = new Map<string, Block>()

  const onNewTx = ({ value: tx }: NewTransactionEvent) => {
    ongoingTxs.set(tx, new Map())
  }

  const onNewBlock = ({ blockHash, parent }: NewBlockEvent) => {
    blocks.set(blockHash, {
      blockHash,
      parent,
      children: [],
    })
    blocks.get(parent)?.children.push(blockHash)

    let body: string[] | null = null
    const getBody = (): string[] => (body = body || api.getBody(blockHash))

    ongoingTxs.entries().forEach(([tx, settlements]) => {
      const parentSettlement = settlements.get(parent)
      if (parentSettlement) {
        settlements.set(blockHash, parentSettlement)
        return
      }

      const settlement: Settled | null = getBody().includes(tx)
        ? {
            blockHash,
            type: "valid",
            successful: api.isTxSuccessful(blockHash, tx),
          }
        : api.isTxValid(blockHash, tx)
          ? null
          : {
              blockHash,
              type: "invalid",
            }

      if (settlement) {
        outputApi.onTxSettled(tx, settlement)
        settlements.set(blockHash, settlement)
      }
    })
  }

  const getDescendants = (block: Block, exclude?: string): string[] =>
    block.children
      .map((bHash) =>
        bHash === exclude ? [] : [bHash, ...getDescendants(blocks.get(bHash)!)],
      )
      .flat()

  const getPruned = (block?: Block, finalizedChild?: string): string[] => {
    if (!block) return []
    const forks = getDescendants(block, finalizedChild)
    const previousBlocks = getPruned(blocks.get(block.parent), block.blockHash)
    return [block.blockHash, ...previousBlocks, ...forks]
  }

  const onFinalized = ({ blockHash }: FinalizedEvent) => {
    ;[...ongoingTxs.entries()].forEach(([tx, settlements]) => {
      const settlement = settlements.get(blockHash)
      if (settlement) {
        outputApi.onTxDone(tx, settlement)
        ongoingTxs.delete(tx)
      }
    })

    const finalized = blocks.get(blockHash)!
    const pruned = getPruned(blocks.get(finalized.parent), blockHash)
    api.unpin(pruned)
    pruned.forEach((blockHash) => {
      blocks.delete(blockHash)
    })
  }

  return (event: IncomingEvent) => {
    switch (event.type) {
      case "newBlock": {
        onNewBlock(event)
        break
      }
      case "newTransaction": {
        onNewTx(event)
        break
      }
      case "finalized":
        onFinalized(event)
    }
  }
}
