import { Injectable, Inject, NotFoundException } from '@nestjs/common'
import { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { DRIZZLE } from '../db/db.module'
import * as schema from '../db/schema'
import { UpdateUserDto } from './dto/update-user.dto'

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async findById(id: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, id),
    })
    if (!user) throw new NotFoundException('User not found')
    const { passwordHash: _, ...safe } = user
    return safe
  }

  async update(id: string, dto: UpdateUserDto) {
    const [updated] = await this.db
      .update(schema.users)
      .set(dto)
      .where(eq(schema.users.id, id))
      .returning()
    if (!updated) throw new NotFoundException('User not found')
    const { passwordHash: _, ...safe } = updated
    return safe
  }
}
