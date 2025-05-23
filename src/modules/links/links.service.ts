import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LinkEntity, LinkStatus } from './entities/links.entity';
import { CreateLinkParams } from './links.service.i';
import { UpdateLinkDTO } from './dto/update-link.dto';
import { LEVEL } from '../user/entities/user.entity';
import * as dayjs from 'dayjs';
import * as timezone from 'dayjs/plugin/timezone';
import * as utc from 'dayjs/plugin/utc';
import { DelayEntity } from '../setting/entities/delay.entity';

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class LinkService {
  ukTimezone = 'Asia/Ho_Chi_Minh';
  constructor(
    @InjectRepository(LinkEntity)
    private repo: Repository<LinkEntity>,
    @InjectRepository(DelayEntity)
    private delayRepository: Repository<DelayEntity>,
    private connection: DataSource
  ) { }

  async create(params: CreateLinkParams) {
    const config = await this.delayRepository.find();
    const linkEntities: Partial<LinkEntity>[] = []
    const linksInValid = [];

    for (const link of params.links) {
      const isExitLink = await this.repo.findOne({
        where: {
          linkUrl: link.url,
          userId: params.userId
        }
      })

      if (!isExitLink) {
        const entity: Partial<LinkEntity> = {
          userId: params.userId,
          linkUrl: link.url,
          delayTime: params.status === LinkStatus.Started ? config[0].delayOn ?? 10 : config[0].delayOff ?? 10,
          status: params.status,
          linkName: link.name
        }
        linkEntities.push(entity)
        continue
      }

      linksInValid.push(link.url)
    }

    const seenUrls = new Set<string>();
    const uniqueLinks: Partial<LinkEntity>[] = [];

    for (const link of linkEntities) {
      if (link.linkUrl && !seenUrls.has(link.linkUrl)) {
        seenUrls.add(link.linkUrl);
        uniqueLinks.push(link);
      }
    }

    await this.repo.save(uniqueLinks);
    if (linksInValid.length > 0) {
      throw new HttpException(
        `Thêm thành công ${linkEntities.length}, Link bị trùng: [${linksInValid.join(',')}]`,
        HttpStatus.BAD_REQUEST,
      );
    }
    throw new HttpException(
      `Thêm thành công ${linkEntities.length} link`,
      HttpStatus.OK,
    );
  }

  getOne(id: number) {
    return this.repo.findOne({
      where: {
        id,
      },
    });
  }

  async getAll(status: LinkStatus, level: LEVEL, userId: number) {
    // const startDate = dayjs().tz(this.ukTimezone)
    //   .format('YYYY-MM-DD 00:00:00')
    // const endDate = dayjs().tz(this.ukTimezone)
    //   .format('YYYY-MM-DD 23:59:59')

    // const response = await this.connection.query(`
    //   SELECT 
    //       l.id,
    //       l.error_message as errorMessage,
    //       l.link_name as linkName,
    //       l.link_url as linkUrl,
    //       l.like,
    //       l.post_id as postId,
    //       l.delay_time as delayTime,
    //       l.status,
    //       l.created_at as createdAt,
    //       l.last_comment_time as lastCommentTime,
    //       l.process,
    //       l.type,
    //       u.email, 
    //       l.count_before AS countBefore,
    //       l.count_after AS countAfter
    //   FROM 
    //       links l
    //   JOIN 
    //       users u ON u.id = l.user_id
    //   LEFT JOIN 
    //       comments c ON c.link_id = l.id
    //   WHERE l.status = ? ${level === LEVEL.USER ? `AND l.user_id = ${userId}` : ''}
    //   AND  l.created_at between "${startDate}" AND "${endDate}"
    //   GROUP BY 
    //       l.id, u.email
    //       order by l.id desc
    // `, [status])

    // return response.map((item) => {
    //   return {
    //     ...item,
    //     createdAt: dayjs(item.createdAt).tz(this.ukTimezone)
    //       .format('YYYY-MM-DD HH:mm:ss')
    //   }
    // })
    const response = await this.connection.query(`
        SELECT 
            l.id,
            l.error_message as errorMessage,
            l.link_name as linkName,
            l.link_url as linkUrl,
            l.like,
            l.post_id as postId,
            l.delay_time as delayTime,
            l.status,
            l.created_at as createdAt,
            l.last_comment_time as lastCommentTime,
            l.process,
            l.type,
            u.email, 
            l.count_before AS countBefore,
            l.count_after AS countAfter
        FROM 
            links l
        JOIN 
            users u ON u.id = l.user_id
        LEFT JOIN 
            comments c ON c.link_id = l.id
        WHERE l.status = ? ${level === LEVEL.USER ? `AND l.user_id = ${userId}` : ''}
        GROUP BY 
            l.id, u.email
            order by l.id desc
      `, [status])

    return response.map((item) => {
      return {
        ...item,
        createdAt: dayjs(item.createdAt).tz(this.ukTimezone)
          .format('YYYY-MM-DD HH:mm:ss'),
        lastCommentTime: item.lastCommentTime ? dayjs(item.lastCommentTime).tz(this.ukTimezone)
          .format('YYYY-MM-DD HH:mm:ss') : null
      }
    })
  }

  update(params: UpdateLinkDTO, level: LEVEL) {
    const argUpdate: Partial<LinkEntity> = {};
    argUpdate.id = params.id;
    argUpdate.linkName = params.linkName;

    if (level === LEVEL.ADMIN) {
      argUpdate.delayTime = params.delayTime;
      argUpdate.type = params.type;
    }

    return this.repo.save(argUpdate);
  }

  delete(id: number) {
    //chưa xử lý stop_monitoring
    return this.repo.delete(id);
  }
}
