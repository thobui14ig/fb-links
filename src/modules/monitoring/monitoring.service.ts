import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { CommentEntity } from '../comments/entities/comment.entity';
import { FacebookService } from '../facebook/facebook.service';
import {
  LinkEntity,
  LinkStatus,
  LinkType
} from '../links/entities/links.entity';
import { LEVEL } from '../user/entities/user.entity';
import { ProcessDTO } from './dto/process.dto';
import { GroupedLinksByType, IPostStarted } from './monitoring.service.i';
import { HttpsProxyAgent } from "https-proxy-agent";
import { TokenEntity, TokenStatus } from '../token/entities/token.entity';
import { CookieEntity, CookieStatus } from '../cookie/entities/cookie.entity';
import { ProxyEntity, ProxyStatus } from '../proxy/entities/proxy.entity';

@Injectable()
export class MonitoringService {
  postIdRunning: string[] = []
  linksPublic: LinkEntity[] = []
  linksPrivate: LinkEntity[] = []
  isHandleUrl: boolean = false

  constructor(
    @InjectRepository(LinkEntity)
    private linkRepository: Repository<LinkEntity>,
    @InjectRepository(CommentEntity)
    private commentRepository: Repository<CommentEntity>,
    private readonly facebookService: FacebookService,
    @InjectRepository(TokenEntity)
    private tokenRepository: Repository<TokenEntity>,
    @InjectRepository(CookieEntity)
    private cookieRepository: Repository<CookieEntity>,
    @InjectRepository(ProxyEntity)
    private proxyRepository: Repository<ProxyEntity>
  ) { }

  async updateProcess(processDTO: ProcessDTO, level: LEVEL, userId: number) {
    if (level === LEVEL.USER) {
      const link = await this.linkRepository.findOne({
        where: {
          userId,
        },
      });

      if (!link) {
        throw new HttpException(`Bạn không có quyền.`, HttpStatus.CONFLICT);
      }
    }

    const response = await this.linkRepository.save(processDTO);

    throw new HttpException(
      `${response.status === LinkStatus.Started ? 'Start' : 'Stop'} monitoring for link_id ${processDTO.id}`,
      HttpStatus.OK,
    );
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async startMonitoring() {
    const postsStarted = await this.getPostStarted()
    const groupPost = this.groupPostsByType(postsStarted || []);

    return Promise.all([this.handle((groupPost.public || []), LinkType.PUBLIC), this.handle((groupPost.private || []), LinkType.PRIVATE)])
  }

  handle(links: LinkEntity[], type: LinkType) {
    let oldLinksRunning = []
    if (type === LinkType.PUBLIC) {
      oldLinksRunning = this.linksPublic
    } else {
      oldLinksRunning = this.linksPrivate
    }


    const oldIdsSet = new Set(oldLinksRunning.map(item => item.id));
    const linksRunning = links.filter(item => !oldIdsSet.has(item.id));

    if (type === LinkType.PUBLIC) {
      this.linksPublic = links
      return this.handlePostsPublic(linksRunning)
    } else {
      this.linksPrivate = links
      return this.handlePostsPrivate(linksRunning)
    }
  }
  async handlePostsPublic(linksRunning: LinkEntity[]) {
    const process = async (link: LinkEntity) => {
      while (true) {
        const isCheckRuning = this.linksPublic.find(item => item.id === link.id)// check còn nằm trong link
        if (!isCheckRuning) { break };
        const currentLink = await this.linkRepository.findOne({
          where: {
            id: link.id
          }
        })
        try {

          if (!currentLink) break;
          const proxy = await this.getRandomProxy()
          if (!proxy) continue
          const postId = `feedback:${link.postId}`;
          const encodedPostId = Buffer.from(postId, 'utf-8').toString('base64');
          const {
            commentId,
            commentMessage,
            phoneNumber,
            userIdComment,
            userNameComment,
            commentCreatedAt
          } = await this.facebookService.getCmtPublic(encodedPostId, proxy) || {}


          if (!commentId || !userIdComment) continue;
          const links = await this.selectLinkUpdate(link.postId)
          const commentEntities: CommentEntity[] = []
          const linkEntities: LinkEntity[] = []

          for (const link of links) {
            const commentEntity: Partial<CommentEntity> = {
              cmtId: commentId,
              linkId: link.id,
              postId: link.postId,
              userId: link.userId,
              uid: userIdComment,
              message: commentMessage,
              phoneNumber,
              name: userNameComment,
              timeCreated: commentCreatedAt as any
            }
            const comment = await this.getComment(link.id, link.userId, commentId)
            commentEntities.push({ ...comment, ...commentEntity } as CommentEntity)

            const linkEntity: LinkEntity = { ...link, lastCommentTime: commentCreatedAt as any }
            linkEntities.push(linkEntity)
          }

          await Promise.all([this.commentRepository.save(commentEntities), this.linkRepository.save(linkEntities)])
        } catch (error) {
          console.log(`Crawl comment with postId ${link.postId} Error.`, error?.message)
        } finally {
          await this.delay(link.delayTime * 1000)
        }
      }
    }
    const postHandle = linksRunning.map((link) => {
      return process(link)
    })

    return Promise.all(postHandle)
  }

  async handlePostsPrivate(linksRunning: LinkEntity[]) {
    const process = async (link: LinkEntity) => {
      while (true) {
        const isCheckRuning = this.linksPrivate.find(item => item.id === link.id)// check còn nằm trong link
        if (!isCheckRuning) { break };
        try {
          const currentLink = await this.linkRepository.findOne({
            where: {
              id: link.id
            }
          })
          if (!currentLink) break;
          const proxy = await this.getRandomProxy()
          if (!proxy) continue

          let dataComment = await this.facebookService.getCommentByCookie(proxy, link.postIdV1) || {}
          if (!dataComment || !(dataComment as any)?.commentId) {
            dataComment = await this.facebookService.getCommentByCookie(proxy, link.postId) || {}
          }

          if (!dataComment || !(dataComment as any)?.commentId) {
            dataComment = await this.facebookService.getCommentByToken(link.postId, proxy) || {}
          }
          const {
            commentId,
            commentMessage,
            phoneNumber,
            userIdComment,
            userNameComment,
            commentCreatedAt
          } = dataComment as any

          if (!commentId || !userIdComment) continue;
          const links = await this.selectLinkUpdate(link.postId)
          const commentEntities: CommentEntity[] = []
          const linkEntities: LinkEntity[] = []

          for (const link of links) {
            const commentEntity: Partial<CommentEntity> = {
              cmtId: commentId,
              linkId: link.id,
              postId: link.postId,
              userId: link.userId,
              uid: userIdComment,
              message: commentMessage,
              phoneNumber,
              name: userNameComment,
              timeCreated: commentCreatedAt as any
            }
            const comment = await this.getComment(link.id, link.userId, commentId)
            commentEntities.push({ ...comment, ...commentEntity } as CommentEntity)

            const linkEntity: LinkEntity = { ...link, lastCommentTime: commentCreatedAt as any }
            linkEntities.push(linkEntity)
          }

          await Promise.all([this.commentRepository.save(commentEntities), this.linkRepository.save(linkEntities)])
        } catch (error) {
          console.log(`Crawl comment with postId ${link.postId} Error.`, error?.message)
        } finally {
          await this.delay(link.delayTime * 1000)
        }
      }

    }
    const postHandle = linksRunning.map((link) => {
      return process(link)
    })

    return Promise.all(postHandle)
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async cronjobHandleProfileUrl() {
    console.log("🚀 ~ MonitoringService ~ cronjobHandleProfileUrl ~ cronjobHandleProfileUrl:")
    if (this.isHandleUrl) {
      return
    }

    const links = await this.getLinksWithoutProfile()
    console.log(11111111)
    if (links.length === 0) {
      this.isHandleUrl = false
      return
    };
    console.log(222222)
    const proxy = await this.getRandomProxy()
    if (!proxy) {
      this.isHandleUrl = false
      return
    };
    console.log(33333)
    const token = await this.getTokenActiveFromDb()
    if (!token) {
      this.isHandleUrl = false
      return
    }
    console.log(44444)
    this.isHandleUrl = true
    const tasks = links.map(async (link) => {
      const { type, name, postId } = await this.facebookService.getProfileLink(link.linkUrl, proxy, token) || {};
      console.log(`🚀 ~ MonitoringService ~ tasks ~ { type, name, postId } :`, { type, name, postId })

      if (!postId) {
        this.isHandleUrl = false
        return
      }

      if (!link.linkName || link.linkName.length === 0) {
        link.linkName = name;
      }
      link.process = true;
      link.type = type;
      link.postId = postId;
      link.postIdV1 = type === LinkType.PRIVATE ? (await this.facebookService.getPostIdV2(link.linkUrl) || null) : null
      await this.linkRepository.save(link);
    });

    await Promise.all(tasks);
    this.isHandleUrl = false
    console.log(55555)
  }

  @Cron(CronExpression.EVERY_HOUR)
  updateLimitToken() {
    return this.updateActiveAllToken()
  }

  private getPostStarted(): Promise<LinkEntity[]> {
    return this.linkRepository.find({
      where: {
        status: LinkStatus.Started,
        type: Not(LinkType.DIE)
      }
    })
  }

  private groupPostsByType(links: LinkEntity[]): GroupedLinksByType {
    return links.reduce((acc, item) => {
      if (!acc[item.type]) {
        acc[item.type] = [];
      }
      acc[item.type].push(item);
      return acc;
    }, {} as Record<'public' | 'private', typeof links>);
  }

  selectLinkUpdate(postId: string) {
    return this.linkRepository.find({
      where: {
        postId,
        status: LinkStatus.Started
      }
    })
  }

  private getComment(linkId: number, userId: number, cmtId: string) {
    return this.commentRepository.findOne({
      where: {
        linkId,
        userId,
        cmtId
      }
    })
  }

  private getLinksWithoutProfile() {
    return this.linkRepository.find({
      where: {
        process: false,
        postId: IsNull()
      },
      select: {
        linkUrl: true,
        id: true,
        postId: true
      }
    })
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getTokenActiveFromDb(): Promise<TokenEntity> {
    return this.tokenRepository.findOne({
      where: {
        status: TokenStatus.ACTIVE
      }
    })
  }

  getCookieActiveFromDb(): Promise<CookieEntity> {
    return this.cookieRepository.findOne({
      where: {
        status: CookieStatus.ACTIVE
      }
    })
  }

  async getRandomProxy() {
    const proxies = await this.proxyRepository.find({
      where: {
        status: ProxyStatus.ACTIVE
      }
    })
    const randomIndex = Math.floor(Math.random() * proxies.length);
    const randomProxy = proxies[randomIndex];

    return randomProxy
  }

  async updateActiveAllToken() {
    console.log("🚀 ~ MonitoringService ~ updateActiveAllToken ~ updateActiveAllToken:")
    const allToken = await this.tokenRepository.find({
      where: {
        status: TokenStatus.LIMIT
      }
    })

    return this.tokenRepository.save(allToken.map((item) => {
      return {
        ...item,
        status: TokenStatus.ACTIVE,
        retryCount: item.retryCount + 1
      }
    }))
  }
}
