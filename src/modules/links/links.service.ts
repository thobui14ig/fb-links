import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as dayjs from 'dayjs';
import * as timezone from 'dayjs/plugin/timezone';
import * as utc from 'dayjs/plugin/utc';
import { DataSource, In, Not, Repository } from 'typeorm';
import { DelayEntity } from '../setting/entities/delay.entity';
import { LEVEL } from '../user/entities/user.entity';
import { UpdateLinkDTO } from './dto/update-link.dto';
import { HideBy, LinkEntity, LinkStatus } from './entities/links.entity';
import { BodyLinkQuery, CreateLinkParams, ISettingLinkDto } from './links.service.i';
import { isNullOrUndefined } from 'src/common/utils/check-utils';

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class LinkService {
  vnTimezone = 'Asia/Bangkok';

  constructor(
    @InjectRepository(LinkEntity)
    private repo: Repository<LinkEntity>,
    @InjectRepository(DelayEntity)
    private delayRepository: Repository<DelayEntity>,
    private connection: DataSource,
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
          delayTime: params.status === LinkStatus.Started ? config[0].delayOnPublic ?? 10 : config[0].delayOff ?? 10,
          status: params.status,
          linkName: link.name,
          hideCmt: params.hideCmt
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

  async getAll(status: LinkStatus, body: BodyLinkQuery, level: LEVEL, userIdByUerLogin: number, isFilter: boolean, hideCmt: boolean) {
    const { type, userId, delayFrom, delayTo, differenceCountCmtFrom, differenceCountCmtTo, lastCommentFrom, lastCommentTo, likeFrom, likeTo } = body
    let queryEntends = ``
    if (hideCmt) {
      queryEntends += ` l.hide_cmt = true`
    } else {
      queryEntends += ` l.hide_cmt = false`
    }
    if (status === LinkStatus.Started) {
      queryEntends += ` AND l.status = 'started'`
    }
    if (status === LinkStatus.Pending) {
      queryEntends += ` AND l.status = 'pending'`
    }

    if (differenceCountCmtFrom && differenceCountCmtTo) {
      queryEntends += ` AND l.count_after between ${differenceCountCmtFrom} and ${differenceCountCmtTo}`
    }

    if (likeFrom && likeTo) {
      queryEntends += ` AND l.like_after between ${likeFrom} and ${likeTo}`
    }

    if (isFilter) {
      if (level === LEVEL.ADMIN) {
        if (type) {
          queryEntends += ` AND l.type='${type}'`
        }
        if (userId) {
          queryEntends += ` AND l.user_id=${userId}`
        }
        if (delayFrom && delayTo) {
          queryEntends += ` AND l.delay_time between ${delayFrom} and ${delayTo}`
        }
      }
    }
    if (level === LEVEL.USER) {
      queryEntends += ` AND l.user_id = ${userIdByUerLogin}`
    }

    let response: any[] = await this.connection.query(`
        SELECT 
            l.id,
            l.error_message as errorMessage,
            l.link_name as linkName,
            l.link_url as linkUrl,
            l.like,
            l.content,
            l.post_id as postId,
            l.delay_time as delayTime,
            l.status,
            l.created_at AS createdAt,
            l.last_comment_time as lastCommentTime,
            l.process,
            l.type,
            u.username, 
            l.count_before AS countBefore,
            l.count_after AS countAfter,
            l.like_before AS likeBefore,
            l.like_after AS likeAfter,
            l.hide_cmt as hideCmt,
            l.hide_by as hideBy
        FROM 
            links l
        JOIN 
            users u ON u.id = l.user_id
        LEFT JOIN 
            comments c ON c.link_id = l.id
        WHERE ${queryEntends}
        GROUP BY 
            l.id, u.username
            order by l.id desc
      `, [])

    const res = response.map((item) => {
      const now = dayjs().utc()
      const utcLastCommentTime = dayjs.utc(item.lastCommentTime);
      const diff = now.diff(utcLastCommentTime, 'hour')
      const utcTime = dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss')

      return {
        ...item,
        createdAt: dayjs.utc(utcTime).tz('Asia/Bangkok').format('YYYY-MM-DD HH:mm:ss'),
        lastCommentTime: item.lastCommentTime ? diff : null
      }
    })

    if (!isNullOrUndefined(lastCommentFrom) && !isNullOrUndefined(lastCommentTo)) {
      return res.filter((item) => item.lastCommentTime && item.lastCommentTime >= lastCommentFrom && item.lastCommentTime <= lastCommentTo)
    }

    return res
  }

  update(params: UpdateLinkDTO, level: LEVEL) {
    const argUpdate: Partial<LinkEntity> = {};
    argUpdate.id = params.id;
    argUpdate.linkName = params.linkName;
    argUpdate.hideCmt = params.hideCmt;

    if (level === LEVEL.ADMIN) {
      argUpdate.delayTime = params.delayTime;
      argUpdate.type = params.type;
    }

    return this.connection.transaction(async (manager) => {
      const record = await manager
        .getRepository(LinkEntity)
        .createQueryBuilder("e")
        .setLock("pessimistic_write")
        .where("e.id = :id", { id: argUpdate.id })
        .getOneOrFail();

      Object.assign(record, argUpdate);

      await manager.save(record);
    });
  }

  delete(id: number) {
    //chưa xử lý stop_monitoring
    return this.repo.delete(id);
  }

  async hideCmt(linkId: number, type: HideBy, userId: number) {
    const link = await this.repo.findOne({
      where: {
        id: linkId
      }
    })
    if (link) {
      link.hideBy = type
      return this.repo.save(link)
    }

    return null
  }

  getkeywordsByLink(linkId: number) {
    return this.repo.findOne({
      where: {
        id: linkId
      },
      relations: {
        keywords: true
      }
    })
  }

  async settingLink(setting: ISettingLinkDto) {
    if (setting.isDelete) {
      return this.repo.delete(setting.linkIds)
    }

    const links = await this.repo.find({
      where: {
        id: In(setting.linkIds)
      }
    })

    const newLinks = links.map((item) => {
      if (setting.onOff) {
        item.status = LinkStatus.Started
      } else {
        item.status = LinkStatus.Pending
      }

      if (setting.delay) {
        item.delayTime = setting.delay
      }

      return item
    })

    return this.repo.save(newLinks)
  }

  async getTotalLinkUserByStatus(userId: number, status: LinkStatus, hideCmt: boolean) {
    const count = await this.connection
      .getRepository(LinkEntity)
      .countBy({
        userId,
        status,
        hideCmt
      })

    return count
  }

  async getTotalLinkUserWhenUpdateMultipleLink(userId: number, status: LinkStatus, hideCmt: boolean, linkIds: number[]) {
    const a = await this.getTotalLinkUserByStatus(userId, status, hideCmt)
    const b = await this.connection
      .getRepository(LinkEntity)
      .countBy({
        userId,
        status: status === LinkStatus.Pending ? LinkStatus.Started : LinkStatus.Pending,
        hideCmt,
        id: In(linkIds)
      })

    return a + b
  }

  async getTotalLinkUser(userId: number) {
    const response = await this.connection.query(`
        SELECT
          (SELECT COUNT(*) FROM links l WHERE l.user_id = u.id AND l.status = 'started') AS totalLinkOn,
          (SELECT COUNT(*) FROM links l WHERE l.user_id = u.id AND l.status = 'pending') AS totalLinkOff
          FROM users u
          WHERE u.id = ${userId};
      `)
    return response[0]
  }
}
