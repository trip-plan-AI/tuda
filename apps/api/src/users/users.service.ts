import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { DRIZZLE } from '../db/db.module';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>) {}

  async findById(id: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, id),
    });
    if (!user) throw new NotFoundException('User not found');

    const { passwordHash: _, ...result } = user;
    return result;
  }

  async update(id: string, dto: UpdateUserDto) {
    const [user] = await this.db
      .update(schema.users)
      .set(dto)
      .where(eq(schema.users.id, id))
      .returning();
    if (!user) throw new NotFoundException('User not found');

    const { passwordHash: _, ...result } = user;
    return result;
  }

  async findByEmail(email: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, email),
    });
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      photo: user.photo,
    };
  }
}
